// scripts/smart-target-master-backtest.js
// Retrofits the Smart-Target GBM vol-bucket methodology (see broker-ai-smart-target-diagnosis.js)
// onto every OTHER backtested signal where it's actually applicable: a signal whose own best
// exit rule is "stop4pct_10d" (10 trading days hold, -4% stop) on daily OHLC bars. Scoped
// deliberately, not applied blindly everywhere:
//   - NOVEM-Suite: 8 of 9 signals qualify (checked against data/novem-backtest-result.json);
//     consultusWeekly's best rule is horizon_4w (no stop, already negative-sharpe) -- excluded,
//     noted below, not silently dropped.
//   - Broker-AI: all 4 signals qualify, already computed in broker-ai-signals-backtest.js --
//     referenced here, not recomputed, to avoid duplicate-but-possibly-divergent numbers.
//   - Pivot-Daily/Monthly, Midpoint-Strategy, RS/Pairs/Longterm, the 14 strat-* factor
//     strategies: their original detector scripts are NOT in this repo (only aggregated result
//     JSON survives from an earlier session's scratchpad) and several use weekly/monthly closes
//     without intraday high/low. Re-deriving their detection logic from formulas alone risks a
//     silently-divergent, less trustworthy copy of "the" backtest -- explicitly OUT of scope here,
//     not attempted. Documented, not hidden.
//
// Detector logic for the 8 NOVEM signals is copied verbatim from scripts/novem-backtest.js
// (not imported, to avoid touching that already-shipped, already-verified script).

const fs = require('fs');
const path = require('path');
const { estimateParams, probHitTarget } = require('./smart-target-lib.js');

const CACHE_PATH = path.join(__dirname, '..', 'data', '.cache', 'novem-ohlc-cache.json');
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
const symbols = Object.keys(cache);

const STOP_PCT = 4;
const MAX_HOLD_DAYS = 10;
const SIGMA_LOOKBACK = 252;
const STOP_T_YEARS = MAX_HOLD_DAYS / 252;

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
  const winTrades = rets.filter(r => r > 0);
  const lossTrades = rets.filter(r => r <= 0);
  const wins = winTrades.length;
  const std = stdev(rets, avg);
  const stopRate = +((trades.filter(t => t.stopped).length / n) * 100).toFixed(2);
  return {
    n, avgRet: +avg.toFixed(4), medianRet: +median.toFixed(4), winRate: +((wins / n) * 100).toFixed(2),
    // avgWin/avgLoss: real achieved trade outcomes -- used for an actual tradeable target price
    // instead of the all-trades-average expectancy (which isn't a price level, see user report).
    avgWin: winTrades.length ? +mean(winTrades).toFixed(4) : null,
    avgLoss: lossTrades.length ? +mean(lossTrades).toFixed(4) : null,
    stdDev: +std.toFixed(4), sharpeLike: std > 0 ? +((avg / std) * Math.sqrt(252)).toFixed(3) : 0, stopRate
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
function volBucketOf(p) { return p < 0.40 ? 'far_lowP' : p < 0.70 ? 'mid_P' : 'near_highP'; }

// ---------- 8 qualifying NOVEM detectors (verbatim copy from novem-backtest.js) ----------
function detectBodySlam(bars) {
  const out = [];
  for (let d = 20; d < bars.length - 1; d++) {
    const sma20 = mean(bars.slice(d - 19, d + 1).map(b => b.close));
    const stretchPct = ((bars[d].close - sma20) / sma20) * 100;
    if (Math.abs(stretchPct) < 6) continue;
    const direction = stretchPct <= -6 ? 'LONG' : 'SHORT';
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}
function detectHiddenSmash(bars) {
  const out = [];
  for (let d = 20; d < bars.length - 1; d++) {
    const today = bars[d], yest = bars[d - 1];
    const bullTrap = today.high > yest.high && today.close < yest.high;
    const bearTrap = today.low < yest.low && today.close > yest.low;
    if (!bullTrap && !bearTrap) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction: bullTrap ? 'SHORT' : 'LONG' });
  }
  return out;
}
function detectPeakValley(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const c0 = bars[d].close, c1 = bars[d - 1].close, c2 = bars[d - 2].close;
    const isValley = c1 === Math.min(c0, c1, c2) && c1 !== c0 && c1 !== c2;
    const isPeak = c1 === Math.max(c0, c1, c2) && c1 !== c0 && c1 !== c2;
    if (!isValley && !isPeak) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction: isValley ? 'LONG' : 'SHORT' });
  }
  return out;
}
function detectVolumina(bars) {
  const out = [];
  for (let d = 5; d < bars.length - 1; d++) {
    const volToday = bars[d].volume, volYest = bars[d - 1].volume;
    if (!(volToday < volYest && volToday > 0)) continue;
    const longLevel = bars[d].close * 1.01, shortLevel = bars[d].close * 0.99;
    let resolved = null;
    for (let j = d + 1; j <= Math.min(d + 10, bars.length - 2); j++) {
      if (bars[j].close > longLevel) { resolved = { idx: j, direction: 'LONG' }; break; }
      if (bars[j].close < shortLevel) { resolved = { idx: j, direction: 'SHORT' }; break; }
    }
    if (!resolved) continue;
    out.push({ entryIdx: resolved.idx + 1, detectIdx: d, detectDate: bars[d].date, direction: resolved.direction });
  }
  return out;
}
function detectConsultusDaily(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const A = bars[d].close, B = bars[d - 1].close, C = bars[d - 2].close;
    if (!(Math.abs(A - B) < Math.abs(C - B))) continue;
    const longTrigger = Math.max(A, B, C), shortTrigger = Math.min(A, B, C);
    let resolved = null;
    for (let j = d + 1; j <= Math.min(d + 10, bars.length - 2); j++) {
      if (bars[j].close > longTrigger) { resolved = { idx: j, direction: 'LONG' }; break; }
      if (bars[j].close < shortTrigger) { resolved = { idx: j, direction: 'SHORT' }; break; }
    }
    if (!resolved) continue;
    out.push({ entryIdx: resolved.idx + 1, detectIdx: d, detectDate: bars[d].date, direction: resolved.direction });
  }
  return out;
}
function detectCorpusParvus(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const bodyA = Math.abs(bars[d - 1].close - bars[d - 1].open);
    const bodyB = Math.abs(bars[d].close - bars[d].open);
    if (!(bodyB < bodyA)) continue;
    const longBreakout = bars[d].close * 1.01, shortBreakout = bars[d].close * 0.99;
    let resolved = null;
    for (let j = d + 1; j <= Math.min(d + 10, bars.length - 2); j++) {
      if (bars[j].close > longBreakout) { resolved = { idx: j, direction: 'LONG' }; break; }
      if (bars[j].close < shortBreakout) { resolved = { idx: j, direction: 'SHORT' }; break; }
    }
    if (!resolved) continue;
    out.push({ entryIdx: resolved.idx + 1, detectIdx: d, detectDate: bars[d].date, direction: resolved.direction });
  }
  return out;
}
function detectDenarius(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const spread = bars[d].close / bars[d - 2].close;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction: spread >= 1.0 ? 'LONG' : 'SHORT' });
  }
  return out;
}
function buildPerf20(bars) {
  const perf = new Array(bars.length).fill(null);
  for (let d = 20; d < bars.length; d++) perf[d] = (bars[d].close - bars[d - 20].close) / bars[d - 20].close;
  return perf;
}

const barsBySymbol = {};
for (const sym of symbols) barsBySymbol[sym] = cache[sym];
const perf20BySymbol = {};
for (const sym of symbols) perf20BySymbol[sym] = buildPerf20(barsBySymbol[sym]);
const dateToUniverseMean = new Map();
for (const sym of symbols) {
  const bars = barsBySymbol[sym], perf = perf20BySymbol[sym];
  for (let d = 20; d < bars.length; d++) {
    if (perf[d] == null) continue;
    const date = bars[d].date;
    if (!dateToUniverseMean.has(date)) dateToUniverseMean.set(date, []);
    dateToUniverseMean.get(date).push(perf[d]);
  }
}
const universeMeanByDate = new Map();
for (const [date, vals] of dateToUniverseMean.entries()) universeMeanByDate.set(date, mean(vals));

function detectArgentum(bars, perf) {
  const out = [];
  const spreadSeries = [];
  for (let d = 20; d < bars.length - 1; d++) {
    const uMean = universeMeanByDate.get(bars[d].date);
    if (perf[d] == null || uMean == null) { spreadSeries.push(null); continue; }
    const spread = perf[d] - uMean;
    spreadSeries.push(spread);
    const windowVals = spreadSeries.slice(-20).filter(v => v != null);
    if (windowVals.length < 10) continue;
    const m = mean(windowVals);
    const sd = Math.max(stdev(windowVals, m), 0.01);
    const zScore = (spread - m) / sd;
    let direction = null;
    if (zScore <= -2.0 || zScore <= -0.75) direction = 'LONG';
    else if (zScore >= 2.0 || zScore >= 0.75) direction = 'SHORT';
    if (!direction) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction });
  }
  return out;
}

const DETECTORS = {
  argentum: detectArgentum, bodySlam: detectBodySlam, hiddenSmash: detectHiddenSmash,
  peakValley: detectPeakValley, denarius: detectDenarius, volumina: detectVolumina,
  consultusDaily: detectConsultusDaily, corpusParvus: detectCorpusParvus
};

const raw = {};
for (const name of Object.keys(DETECTORS)) raw[name] = [];
for (const sym of symbols) {
  const bars = barsBySymbol[sym];
  for (const [name, fn] of Object.entries(DETECTORS)) {
    const args = name === 'argentum' ? [bars, perf20BySymbol[sym]] : [bars];
    const instances = fn(...args).map(inst => ({ sym, ...inst }));
    raw[name].push(...instances);
  }
}

// ---------- smart-target bucket + stop4pct_10d exit per instance ----------
function summarizeByVolBucket(instances) {
  const buckets = { far_lowP: [], mid_P: [], near_highP: [] };
  for (const i of instances) {
    if (!i.volBucket || i.exit == null) continue;
    buckets[i.volBucket].push({ retPct: i.exit.retPct, detectDate: i.detectDate, stopped: !!i.exit.stopped });
  }
  const result = {};
  for (const [bk, trades] of Object.entries(buckets)) {
    const { older, newer } = splitHalves(trades);
    result[bk] = { ...summarize(trades), olderHalf: summarize(older), newerHalf: summarize(newer) };
  }
  return result;
}

const novemMaster = {};
let skippedNoHistory = 0;

for (const [name, instances] of Object.entries(raw)) {
  for (const inst of instances) {
    const bars = barsBySymbol[inst.sym];
    if (inst.entryIdx >= bars.length) continue;
    inst.exit = applyMultiDayStop(bars, inst.entryIdx, inst.direction, MAX_HOLD_DAYS, STOP_PCT);

    const closes = bars.map(b => b.close);
    const histStart = Math.max(0, inst.detectIdx - SIGMA_LOOKBACK + 1);
    const trailing = closes.slice(histStart, inst.detectIdx + 1);
    const params = estimateParams(trailing);
    if (!params) { skippedNoHistory++; continue; }
    const entry = bars[inst.entryIdx].open;
    const stopLevel = inst.direction === 'LONG' ? entry * (1 - STOP_PCT / 100) : entry * (1 + STOP_PCT / 100);
    inst.pTouchStop = probHitTarget(entry, stopLevel, params.mu, params.sigma, STOP_T_YEARS);
    inst.volBucket = volBucketOf(inst.pTouchStop);
  }
  novemMaster[name] = { n: instances.length, volFilter: summarizeByVolBucket(instances) };
}

// ---------- fold in already-computed Broker-AI buckets (reference, not recompute) ----------
const BROKER_AI_RESULT_PATH = path.join(__dirname, '..', 'data', 'broker-ai-signals-backtest-result.json');
let brokerAi = {};
try {
  const bd = JSON.parse(fs.readFileSync(BROKER_AI_RESULT_PATH, 'utf8'));
  for (const [name, e] of Object.entries(bd.logics)) brokerAi[name] = { n: e.n, volFilter: e.volFilter };
} catch (e) { console.error('Could not load broker-ai result:', e.message); }

// ---------- master ranking: every (signal, bucket) combo with n>=200, ranked by sharpe ----------
const MIN_N = 200;
const combos = [];
for (const [family, signals] of [['novem', novemMaster], ['brokerAi', brokerAi]]) {
  for (const [name, data] of Object.entries(signals)) {
    for (const [bucket, s] of Object.entries(data.volFilter)) {
      if (!s.n || s.n < MIN_N) continue;
      combos.push({ family, signal: name, bucket, n: s.n, avgRet: s.avgRet, medianRet: s.medianRet, winRate: s.winRate, avgWin: s.avgWin, avgLoss: s.avgLoss, sharpeLike: s.sharpeLike, olderHalf: s.olderHalf, newerHalf: s.newerHalf });
    }
  }
}
combos.sort((a, b) => b.sharpeLike - a.sharpeLike);

const output = {
  meta: {
    generatedAt: new Date().toISOString(),
    symbols: symbols.length,
    stopPct: STOP_PCT, maxHoldDays: MAX_HOLD_DAYS,
    scope: 'NOVEM (8/9 signals, consultusWeekly excluded -- no stop-based best rule) + Broker-AI (4/4 signals). Pivot-Daily/Monthly, Midpoint-Strategy, RS/Pairs/Longterm, 14 strat-* factor strategies explicitly OUT of scope (original detector scripts not present in repo, re-derivation from formulas alone deemed untrustworthy).',
    skippedNoHistory
  },
  novem: novemMaster,
  brokerAi,
  masterRanking: combos
};

fs.writeFileSync(path.join(__dirname, '..', 'data', 'smart-target-master-result.json'), JSON.stringify(output, null, 2));

console.log('=== Smart-Target Master Backtest ===');
console.log('Top 15 (signal, bucket) combos by Sharpe-like (n >= ' + MIN_N + '):\n');
for (const c of combos.slice(0, 15)) {
  console.log(`${c.family.padEnd(9)} ${c.signal.padEnd(16)} ${c.bucket.padEnd(11)} n=${String(c.n).padStart(6)} avgRet=${c.avgRet.toFixed(3)}% winRate=${c.winRate}% sharpe=${c.sharpeLike}`);
}
console.log('\nWritten to data/smart-target-master-result.json');
