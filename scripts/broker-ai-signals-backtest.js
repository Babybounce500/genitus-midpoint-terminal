// scripts/broker-ai-signals-backtest.js
// Rigorous backtest of the 4 signals actually shipped in mcp-server/trading/broker-ai-trade-signals.html
// (getMonthlyAnalysis, getSpreadAnalysis, getStockInfo [the "midpoint" signal], getWeeklySMAAnalysis).
// None of the 4 had any historical validation in the original file -- each just emits a hardcoded
// +/-% target/stop guess. This replicates each signal's exact live decision rule, lookahead-free
// (entry = next day's open, never the close that produced the signal), then runs the same
// exit-rule-sweep + two-period robustness split used throughout this repo (novem-backtest.js).
// Reuses the existing 52-symbol/3-year split-adjusted OHLCV cache -- no new fetch needed.

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', '.cache', 'novem-ohlc-cache.json');
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
const symbols = Object.keys(cache);

const STOP_PCT = 4;
const MAX_HOLD_DAYS = 10;
const REVERSAL_CAP_DAYS = 20;

function mean(arr) { return arr.reduce((a, v) => a + v, 0) / arr.length; }
function stdev(arr, m) { if (arr.length < 2) return 0; const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1); return Math.sqrt(v); }

function summarize(trades, retKey) {
  retKey = retKey || 'retPct';
  const n = trades.length;
  if (!n) return { n: 0 };
  const rets = trades.map(t => t[retKey]);
  const avg = mean(rets);
  const sorted = rets.slice().sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = rets.filter(r => r > 0).length;
  const std = stdev(rets, avg);
  return {
    n,
    avgRet: +avg.toFixed(4),
    medianRet: +median.toFixed(4),
    winRate: +((wins / n) * 100).toFixed(2),
    stdDev: +std.toFixed(4),
    sharpeLike: std > 0 ? +((avg / std) * Math.sqrt(252)).toFixed(3) : 0,
    worstTrade: +sorted[0].toFixed(2),
    bestTrade: +sorted[n - 1].toFixed(2)
  };
}

function splitHalves(trades) {
  const dates = [...new Set(trades.map(t => t.detectDate))].sort();
  if (!dates.length) return { older: [], newer: [], splitDate: null };
  const mid = dates[Math.floor(dates.length / 2)];
  return { older: trades.filter(t => t.detectDate < mid), newer: trades.filter(t => t.detectDate >= mid), splitDate: mid };
}

// Multi-day worst-case stop (same convention as pivot-daily-backtest.js / novem-backtest.js):
// walk forward from entryIdx, if ANY day's range in the window breaches the stop, exit there.
function applyMultiDayStop(bars, entryIdx, direction, maxHoldDays, stopPct) {
  const entry = bars[entryIdx].open;
  const lastIdx = Math.min(entryIdx + maxHoldDays - 1, bars.length - 1);
  if (direction === 'LONG') {
    const stopPrice = entry * (1 - stopPct / 100);
    for (let i = entryIdx; i <= lastIdx; i++) {
      if (bars[i].low <= stopPrice) return { retPct: -stopPct, stopped: true };
    }
    return { retPct: ((bars[lastIdx].close - entry) / entry) * 100, stopped: false };
  }
  const stopPrice = entry * (1 + stopPct / 100);
  for (let i = entryIdx; i <= lastIdx; i++) {
    if (bars[i].high >= stopPrice) return { retPct: -stopPct, stopped: true };
  }
  return { retPct: ((entry - bars[lastIdx].close) / entry) * 100, stopped: false };
}

function fixedHorizon(bars, entryIdx, direction, holdDays) {
  const entry = bars[entryIdx].open;
  const exitIdx = Math.min(entryIdx + holdDays - 1, bars.length - 1);
  const exitPrice = bars[exitIdx].close;
  const retPct = direction === 'LONG' ? ((exitPrice - entry) / entry) * 100 : ((entry - exitPrice) / entry) * 100;
  return { retPct };
}

function computeExitVariants(bars, entryIdx, direction) {
  if (entryIdx >= bars.length) return null;
  return {
    horizon_1d: fixedHorizon(bars, entryIdx, direction, 1),
    horizon_3d: fixedHorizon(bars, entryIdx, direction, 3),
    horizon_5d: fixedHorizon(bars, entryIdx, direction, 5),
    horizon_10d: fixedHorizon(bars, entryIdx, direction, 10),
    stop4pct_10d: applyMultiDayStop(bars, entryIdx, direction, MAX_HOLD_DAYS, STOP_PCT)
  };
}

function attachSignalReversal(instances, bars) {
  const sorted = instances.slice().sort((a, b) => a.entryIdx - b.entryIdx);
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    let reversal = null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].entryIdx > cur.entryIdx + REVERSAL_CAP_DAYS) break;
      if (sorted[j].direction !== cur.direction) { reversal = sorted[j]; break; }
    }
    const capIdx = Math.min(cur.entryIdx + REVERSAL_CAP_DAYS, bars.length - 1);
    const exitIdx = reversal ? Math.max(cur.entryIdx, reversal.entryIdx - 1) : capIdx;
    if (exitIdx >= bars.length || cur.entryIdx >= bars.length) { cur.signalReversal = null; continue; }
    const entry = bars[cur.entryIdx].open, exitPrice = bars[exitIdx].close;
    const retPct = cur.direction === 'LONG' ? ((exitPrice - entry) / entry) * 100 : ((entry - exitPrice) / entry) * 100;
    cur.signalReversal = { retPct };
  }
}

// ========================================================================
// 4 DETECTORS -- each replicates the EXACT live decision rule from
// mcp-server/trading/broker-ai-trade-signals.html, evaluated once per trading
// day using only data available through that day's close. entryIdx = d+1
// (next day's open), never the bar that produced the signal.
// ========================================================================

// getMonthlyAnalysis(): position = latestClose > lastFridayOfPrevMonthClose ? LONG : SHORT.
// Live version recomputes "last month" relative to "today" every call -- the reference price
// is fixed for an entire calendar month and only steps forward when the month rolls over.
function detectMonthly(bars) {
  const out = [];
  // Precompute, for each bar, the close of "the last Friday-or-earlier trading day of the
  // previous calendar month" (walking backward from that bar's own month).
  for (let d = 0; d < bars.length - 1; d++) {
    const dt = new Date(bars[d].date + 'T00:00:00Z');
    let month = dt.getUTCMonth(); // 0-11, this bar's month
    let year = dt.getUTCFullYear();
    let prevMonth = month === 0 ? 11 : month - 1;
    let prevYear = month === 0 ? year - 1 : year;
    const lastDayPrevMonth = new Date(Date.UTC(prevYear, prevMonth + 1, 0));
    while (lastDayPrevMonth.getUTCDay() !== 5) lastDayPrevMonth.setUTCDate(lastDayPrevMonth.getUTCDate() - 1);
    const targetISO = lastDayPrevMonth.toISOString().slice(0, 10);
    // Find the most recent bar at or before targetISO (walk back from d, since bars are
    // ascending and targetISO is always well before d for any d inside the current month).
    let refIdx = -1;
    for (let i = Math.min(d, bars.length - 1); i >= 0; i--) {
      if (bars[i].date <= targetISO) { refIdx = i; break; }
    }
    if (refIdx < 0) continue; // not enough history yet (first month in the cache)
    const refClose = bars[refIdx].close;
    const direction = bars[d].close > refClose ? 'LONG' : 'SHORT';
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}

// getSpreadAnalysis(): spread = latestClose / close-2-trading-days-ago (3rd most recent bar).
function detectSpread(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const spread = bars[d].close / bars[d - 2].close;
    if (spread === 1) continue;
    const direction = spread > 1 ? 'LONG' : 'SHORT';
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}

// getStockInfo(): avgPrice = (high+low)/2 of the SAME day; direction = close vs that midpoint.
// This is the signal the user calls "midpoint analysis" -- note it is the CURRENT day's own
// range midpoint, not a prior-day reference (unlike the already-validated genitus midpoint system).
function detectMidpoint(bars) {
  const out = [];
  for (let d = 0; d < bars.length - 1; d++) {
    const avgPrice = (bars[d].high + bars[d].low) / 2;
    if (bars[d].close === avgPrice) continue; // "Neutral" in the live tool -- no trade
    const direction = bars[d].close > avgPrice ? 'LONG' : 'SHORT';
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}

// getWeeklySMAAnalysis(): sma1 = avg(close[d],close[d-1],close[d-2]); sma3 = avg(close[d-2],close[d-3],close[d-4])
// (the two 3-bar windows deliberately overlap at d-2, exactly as in the live code).
function detectWeeklySMA(bars) {
  const out = [];
  for (let d = 4; d < bars.length - 1; d++) {
    const sma1 = (bars[d].close + bars[d - 1].close + bars[d - 2].close) / 3;
    const sma3 = (bars[d - 2].close + bars[d - 3].close + bars[d - 4].close) / 3;
    const spread = sma1 / sma3;
    if (spread === 1) continue;
    const direction = spread > 1 ? 'LONG' : 'SHORT';
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}

const DETECTORS = {
  monthly: detectMonthly,
  spread: detectSpread,
  midpoint: detectMidpoint,
  weeklySma: detectWeeklySMA
};

// ---------- run all detectors over all symbols ----------
const raw = {}; // logicName -> [{sym, entryIdx, detectIdx, detectDate, direction, exits, signalReversal}]
for (const logicName of Object.keys(DETECTORS)) raw[logicName] = [];

for (const sym of symbols) {
  const bars = cache[sym];
  if (!bars || bars.length < 60) continue;
  for (const [logicName, fn] of Object.entries(DETECTORS)) {
    const instances = fn(bars).map(inst => ({ sym, ...inst }));
    raw[logicName].push(...instances);
  }
}

for (const [logicName, instances] of Object.entries(raw)) {
  const bySym = {};
  for (const inst of instances) { if (!bySym[inst.sym]) bySym[inst.sym] = []; bySym[inst.sym].push(inst); }
  for (const sym of Object.keys(bySym)) attachSignalReversal(bySym[sym], cache[sym]);
  for (const inst of instances) {
    const variants = computeExitVariants(cache[inst.sym], inst.entryIdx, inst.direction);
    inst.exits = variants ? { ...variants, signal_reversal: inst.signalReversal } : { signal_reversal: inst.signalReversal };
  }
}

function summarizeByExitRule(instances, exitRuleKeys) {
  const result = {};
  for (const key of exitRuleKeys) {
    const trades = instances.filter(i => i.exits[key] != null).map(i => ({ retPct: i.exits[key].retPct, detectDate: i.detectDate, stopped: !!i.exits[key].stopped }));
    const { older, newer } = splitHalves(trades);
    const stopRate = trades.length ? +((trades.filter(t => t.stopped).length / trades.length) * 100).toFixed(2) : 0;
    result[key] = { ...summarize(trades), stopRate, olderHalf: summarize(older), newerHalf: summarize(newer) };
  }
  return result;
}

const EXIT_KEYS = ['horizon_1d', 'horizon_3d', 'horizon_5d', 'horizon_10d', 'stop4pct_10d', 'signal_reversal'];

function bestExitRule(exitRules) {
  let best = null;
  for (const [exitKey, s] of Object.entries(exitRules)) {
    if (!s || !s.n) continue;
    if (!best || s.sharpeLike > best.sharpeLike) best = { exitKey, ...s };
  }
  return best;
}

const output = { meta: { symbols: symbols.length, generatedAt: new Date().toISOString() }, logics: {}, confluence: {} };

for (const [logicName, instances] of Object.entries(raw)) {
  const exitRules = summarizeByExitRule(instances, EXIT_KEYS);
  const best = bestExitRule(exitRules);
  const longInstances = instances.filter(i => i.direction === 'LONG');
  const shortInstances = instances.filter(i => i.direction === 'SHORT');

  output.logics[logicName] = {
    n: instances.length,
    long: { n: longInstances.length, exitRules: summarizeByExitRule(longInstances, EXIT_KEYS) },
    short: { n: shortInstances.length, exitRules: summarizeByExitRule(shortInstances, EXIT_KEYS) },
    exitRules,
    bestExitRule: best
  };
}

// ---------- confluence: how many of the 4 signals agree on direction, same symbol+day ----------
// Fixed exit rule for a fair comparison (not each signal's own best), same convention as NOVEM.
const CONFLUENCE_EXIT = 'horizon_5d';
const bySymDate = {}; // sym -> date -> { LONG: n, SHORT: n, entryIdx, bars }
for (const [logicName, instances] of Object.entries(raw)) {
  for (const inst of instances) {
    const k = inst.sym;
    if (!bySymDate[k]) bySymDate[k] = {};
    if (!bySymDate[k][inst.detectDate]) bySymDate[k][inst.detectDate] = { LONG: 0, SHORT: 0, entryIdx: inst.entryIdx };
    bySymDate[k][inst.detectDate][inst.direction]++;
  }
}
const confluenceTrades = { tier1: [], tier2: [], tier3plus: [] };
for (const sym of Object.keys(bySymDate)) {
  const bars = cache[sym];
  for (const [date, agg] of Object.entries(bySymDate[sym])) {
    const total = agg.LONG + agg.SHORT;
    const agreeCount = Math.max(agg.LONG, agg.SHORT);
    if (agreeCount < 1) continue;
    const direction = agg.LONG >= agg.SHORT ? 'LONG' : 'SHORT';
    const variant = fixedHorizon(bars, agg.entryIdx, direction, 5);
    if (agg.entryIdx >= bars.length) continue;
    const trade = { retPct: variant.retPct, detectDate: date };
    if (agreeCount === 1) confluenceTrades.tier1.push(trade);
    else if (agreeCount === 2) confluenceTrades.tier2.push(trade);
    else confluenceTrades.tier3plus.push(trade);
  }
}
for (const tier of Object.keys(confluenceTrades)) {
  output.confluence[tier] = summarize(confluenceTrades[tier]);
}

const OUT_PATH = path.join(__dirname, '..', 'data', 'broker-ai-signals-backtest-result.json');
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

console.log('=== Broker-AI Signals Backtest ===');
for (const [logicName, data] of Object.entries(output.logics)) {
  console.log(`\n${logicName}: n=${data.n} (LONG ${data.long.n} / SHORT ${data.short.n})`);
  if (data.bestExitRule) {
    console.log(`  BEST: ${data.bestExitRule.exitKey} | avgRet=${data.bestExitRule.avgRet}% winRate=${data.bestExitRule.winRate}% sharpeLike=${data.bestExitRule.sharpeLike} n=${data.bestExitRule.n}`);
    console.log(`  Robustness: older sharpe=${data.bestExitRule.olderHalf.sharpeLike ?? 'n/a'} (n=${data.bestExitRule.olderHalf.n}) | newer sharpe=${data.bestExitRule.newerHalf.sharpeLike ?? 'n/a'} (n=${data.bestExitRule.newerHalf.n})`);
  } else {
    console.log('  no valid exit rule (all n=0)');
  }
}
console.log('\nConfluence (fixed horizon_5d):');
for (const [tier, s] of Object.entries(output.confluence)) {
  console.log(`  ${tier}: n=${s.n} avgRet=${s.avgRet ?? 'n/a'}% winRate=${s.winRate ?? 'n/a'}% sharpeLike=${s.sharpeLike ?? 'n/a'}`);
}
console.log('\nWritten to', OUT_PATH);
