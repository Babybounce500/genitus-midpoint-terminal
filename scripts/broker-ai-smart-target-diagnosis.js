// scripts/broker-ai-smart-target-diagnosis.js
// Step 1 of the "smart target" proposal: diagnose, on trades we've ALREADY backtested
// (broker-ai-signals-backtest.js), whether the flat "-4% stop, 10 day hold" rule is secretly
// volatility-biased -- i.e. whether trades where -4% was a "close" GBM first-passage distance
// (high P(touch), per the live Target-Scanner's own math) perform worse than trades where -4%
// was "far" (low P(touch)). If so, that's the case for replacing the flat % stop with a
// sigma-normalized one. This is read-only diagnosis -- no exit rule is changed here.
//
// Reuses the existing 52-symbol/3-year cache. Detector logic duplicated (not imported) from
// broker-ai-signals-backtest.js intentionally, to avoid touching that already-shipped,
// already-verified script.

const fs = require('fs');
const path = require('path');
const { estimateParams, probHitTarget } = require('./smart-target-lib.js');

const CACHE_PATH = path.join(__dirname, '..', 'data', '.cache', 'novem-ohlc-cache.json');
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
const symbols = Object.keys(cache);

const STOP_PCT = 4;
const MAX_HOLD_DAYS = 10;
const SIGMA_LOOKBACK = 252; // trailing trading days used to estimate sigma/mu at entry time

function mean(arr) { return arr.reduce((a, v) => a + v, 0) / arr.length; }
function stdev(arr, m) { if (arr.length < 2) return 0; const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1); return Math.sqrt(v); }

function summarize(trades, retKey) {
  retKey = retKey || 'retPct';
  const n = trades.length;
  if (!n) return { n: 0 };
  const rets = trades.map(t => t[retKey]);
  const avg = mean(rets);
  const std = stdev(rets, avg);
  const wins = rets.filter(r => r > 0).length;
  const stopRate = +((trades.filter(t => t.stopped).length / n) * 100).toFixed(2);
  return {
    n, avgRet: +avg.toFixed(4), winRate: +((wins / n) * 100).toFixed(2), stopRate,
    sharpeLike: std > 0 ? +((avg / std) * Math.sqrt(252)).toFixed(3) : 0
  };
}

function splitHalves(trades) {
  const dates = [...new Set(trades.map(t => t.detectDate))].sort();
  if (!dates.length) return { older: [], newer: [] };
  const mid = dates[Math.floor(dates.length / 2)];
  return { older: trades.filter(t => t.detectDate < mid), newer: trades.filter(t => t.detectDate >= mid) };
}

function applyMultiDayStop(bars, entryIdx, direction, maxHoldDays, stopPct) {
  const entry = bars[entryIdx].open;
  const lastIdx = Math.min(entryIdx + maxHoldDays - 1, bars.length - 1);
  if (direction === 'LONG') {
    const stopPrice = entry * (1 - stopPct / 100);
    for (let i = entryIdx; i <= lastIdx; i++) if (bars[i].low <= stopPrice) return { retPct: -stopPct, stopped: true };
    return { retPct: ((bars[lastIdx].close - entry) / entry) * 100, stopped: false };
  }
  const stopPrice = entry * (1 + stopPct / 100);
  for (let i = entryIdx; i <= lastIdx; i++) if (bars[i].high >= stopPrice) return { retPct: -stopPct, stopped: true };
  return { retPct: ((entry - bars[lastIdx].close) / entry) * 100, stopped: false };
}

// ---------- 4 detectors (verbatim copy from broker-ai-signals-backtest.js) ----------
function detectMonthly(bars) {
  const out = [];
  for (let d = 0; d < bars.length - 1; d++) {
    const dt = new Date(bars[d].date + 'T00:00:00Z');
    let month = dt.getUTCMonth(), year = dt.getUTCFullYear();
    let prevMonth = month === 0 ? 11 : month - 1, prevYear = month === 0 ? year - 1 : year;
    const lastDayPrevMonth = new Date(Date.UTC(prevYear, prevMonth + 1, 0));
    while (lastDayPrevMonth.getUTCDay() !== 5) lastDayPrevMonth.setUTCDate(lastDayPrevMonth.getUTCDate() - 1);
    const targetISO = lastDayPrevMonth.toISOString().slice(0, 10);
    let refIdx = -1;
    for (let i = Math.min(d, bars.length - 1); i >= 0; i--) if (bars[i].date <= targetISO) { refIdx = i; break; }
    if (refIdx < 0) continue;
    const direction = bars[d].close > bars[refIdx].close ? 'LONG' : 'SHORT';
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}
function detectSpread(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const spread = bars[d].close / bars[d - 2].close;
    if (spread === 1) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction: spread > 1 ? 'LONG' : 'SHORT' });
  }
  return out;
}
function detectMidpoint(bars) {
  const out = [];
  for (let d = 0; d < bars.length - 1; d++) {
    const avgPrice = (bars[d].high + bars[d].low) / 2;
    if (bars[d].close === avgPrice) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction: bars[d].close > avgPrice ? 'LONG' : 'SHORT' });
  }
  return out;
}
function detectWeeklySMA(bars) {
  const out = [];
  for (let d = 4; d < bars.length - 1; d++) {
    const sma1 = (bars[d].close + bars[d - 1].close + bars[d - 2].close) / 3;
    const sma3 = (bars[d - 2].close + bars[d - 3].close + bars[d - 4].close) / 3;
    const spread = sma1 / sma3;
    if (spread === 1) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction: spread > 1 ? 'LONG' : 'SHORT' });
  }
  return out;
}
const DETECTORS = { monthly: detectMonthly, spread: detectSpread, midpoint: detectMidpoint, weeklySma: detectWeeklySMA };

// ---------- run + diagnose ----------
const T = MAX_HOLD_DAYS / 252; // years, matches stop4pct_10d's holding window

const byLogic = {}; // logicName -> trades[] with { retPct, stopped, detectDate, pTouchStop }
for (const logicName of Object.keys(DETECTORS)) byLogic[logicName] = [];

let skippedNoHistory = 0;

for (const sym of symbols) {
  const bars = cache[sym];
  if (!bars || bars.length < 60) continue;
  const closes = bars.map(b => b.close);

  for (const [logicName, fn] of Object.entries(DETECTORS)) {
    const instances = fn(bars);
    for (const inst of instances) {
      if (inst.entryIdx >= bars.length) continue;
      // Trailing window strictly BEFORE entry (lookahead-free): up to and including detectIdx.
      const histStart = Math.max(0, inst.detectIdx - SIGMA_LOOKBACK + 1);
      const trailing = closes.slice(histStart, inst.detectIdx + 1);
      const params = estimateParams(trailing);
      if (!params) { skippedNoHistory++; continue; }

      const entry = bars[inst.entryIdx].open;
      const stopLevel = inst.direction === 'LONG' ? entry * (1 - STOP_PCT / 100) : entry * (1 + STOP_PCT / 100);
      const pTouchStop = probHitTarget(entry, stopLevel, params.mu, params.sigma, T);

      const exit = applyMultiDayStop(bars, inst.entryIdx, inst.direction, MAX_HOLD_DAYS, STOP_PCT);
      byLogic[logicName].push({ retPct: exit.retPct, stopped: exit.stopped, detectDate: inst.detectDate, pTouchStop, sigma: params.sigma });
    }
  }
}

function bucketOf(p) { return p < 0.40 ? 'far_lowP' : p < 0.70 ? 'mid_P' : 'near_highP'; }

console.log('=== Smart-Target Diagnosis: is the flat -4% stop secretly vol-biased? ===');
console.log('(skipped for insufficient trailing history:', skippedNoHistory, ')\n');

const overallBuckets = { far_lowP: [], mid_P: [], near_highP: [] };

for (const [logicName, trades] of Object.entries(byLogic)) {
  console.log(`--- ${logicName} (n=${trades.length}) ---`);
  const buckets = { far_lowP: [], mid_P: [], near_highP: [] };
  for (const t of trades) { buckets[bucketOf(t.pTouchStop)].push(t); overallBuckets[bucketOf(t.pTouchStop)].push(t); }
  for (const [bk, bt] of Object.entries(buckets)) {
    const s = summarize(bt);
    const { older, newer } = splitHalves(bt);
    const so = summarize(older), sn = summarize(newer);
    console.log(`  ${bk.padEnd(11)} n=${String(s.n).padStart(6)} avgRet=${(s.avgRet ?? 0).toFixed(3)}% winRate=${s.winRate ?? 0}% stopRate=${s.stopRate ?? 0}% sharpe=${s.sharpeLike ?? 0}  | older sharpe=${so.sharpeLike ?? 'n/a'} (n=${so.n}) -> newer sharpe=${sn.sharpeLike ?? 'n/a'} (n=${sn.n})`);
  }
  console.log('');
}

console.log('--- ALL 4 SIGNALS COMBINED, bucketed by P(touch -4% stop within 10d) ---');
for (const [bk, bt] of Object.entries(overallBuckets)) {
  const s = summarize(bt);
  const avgSigma = mean(bt.map(t => t.sigma)) * 100;
  console.log(`  ${bk.padEnd(11)} n=${String(s.n).padStart(6)} avgRet=${(s.avgRet ?? 0).toFixed(3)}% winRate=${s.winRate ?? 0}% stopRate=${s.stopRate ?? 0}% sharpe=${s.sharpeLike ?? 0}  avg_sigma=${avgSigma.toFixed(1)}%`);
}

const out = { byLogic: {}, overallBuckets: {} };
for (const [logicName, trades] of Object.entries(byLogic)) {
  const buckets = { far_lowP: [], mid_P: [], near_highP: [] };
  for (const t of trades) buckets[bucketOf(t.pTouchStop)].push(t);
  out.byLogic[logicName] = {};
  for (const [bk, bt] of Object.entries(buckets)) {
    const { older, newer } = splitHalves(bt);
    out.byLogic[logicName][bk] = { ...summarize(bt), olderHalf: summarize(older), newerHalf: summarize(newer) };
  }
}
for (const [bk, bt] of Object.entries(overallBuckets)) {
  const { older, newer } = splitHalves(bt);
  out.overallBuckets[bk] = { ...summarize(bt), olderHalf: summarize(older), newerHalf: summarize(newer), avgSigmaPct: +(mean(bt.map(t => t.sigma)) * 100).toFixed(1) };
}
fs.writeFileSync(path.join(__dirname, '..', 'data', 'smart-target-diagnosis-result.json'), JSON.stringify(out, null, 2));
console.log('\nWritten to data/smart-target-diagnosis-result.json');
