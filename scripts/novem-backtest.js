const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', '.cache', 'novem-ohlc-cache.json');
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
const symbols = Object.keys(cache);

const STOP_PCT = 4;
const MAX_HOLD_DAYS = 10;
const REVERSAL_CAP_DAYS = 20;

// ---------- generic helpers ----------
function mean(arr) { return arr.reduce((a, v) => a + v, 0) / arr.length; }
function stdev(arr, m) { if (arr.length < 2) return 0; const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1); return Math.sqrt(v); }

function stdDevOf(arr, meanV) { return stdev(arr, meanV); }

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

// Multi-day worst-case stop: walk forward from entryIdx, if ANY day's range in the window
// breaches the stop price, exit there at the stop price (conservative, same convention as
// pivot-daily-backtest.js). Otherwise exit at the close of the last day in the window.
function applyMultiDayStop(bars, entryIdx, direction, maxHoldDays, stopPct) {
  const entry = bars[entryIdx].open;
  const lastIdx = Math.min(entryIdx + maxHoldDays - 1, bars.length - 1);
  if (direction === 'LONG') {
    const stopPrice = entry * (1 - stopPct / 100);
    for (let i = entryIdx; i <= lastIdx; i++) {
      if (bars[i].low <= stopPrice) return { retPct: -stopPct, stopped: true, exitIdx: i };
    }
    return { retPct: ((bars[lastIdx].close - entry) / entry) * 100, stopped: false, exitIdx: lastIdx };
  }
  const stopPrice = entry * (1 + stopPct / 100);
  for (let i = entryIdx; i <= lastIdx; i++) {
    if (bars[i].high >= stopPrice) return { retPct: -stopPct, stopped: true, exitIdx: i };
  }
  return { retPct: ((entry - bars[lastIdx].close) / entry) * 100, stopped: false, exitIdx: lastIdx };
}

function fixedHorizon(bars, entryIdx, direction, holdDays) {
  const entry = bars[entryIdx].open;
  const exitIdx = Math.min(entryIdx + holdDays - 1, bars.length - 1);
  const exitPrice = bars[exitIdx].close;
  const retPct = direction === 'LONG' ? ((exitPrice - entry) / entry) * 100 : ((entry - exitPrice) / entry) * 100;
  return { retPct, exitIdx };
}

// ---------- weekly grouping (last trading day per ISO week = house convention) ----------
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - dow));
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((thursday - jan1) / 86400000) + 1) / 7);
  return isoYear + '-W' + isoWeek;
}
function buildWeeklyIndex(bars) {
  // Returns array of { lastBarIdx, firstBarIdx, close } one entry per week, ascending.
  const weeks = new Map();
  bars.forEach((b, idx) => {
    const k = isoWeekKey(b.date);
    if (!weeks.has(k)) weeks.set(k, { firstBarIdx: idx, lastBarIdx: idx });
    else weeks.get(k).lastBarIdx = idx;
  });
  return [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, w]) => ({
    key: k, firstBarIdx: w.firstBarIdx, lastBarIdx: w.lastBarIdx, close: bars[w.lastBarIdx].close
  }));
}

// ========================================================================
// 9 DETECTORS. Each returns resolved instances: { entryIdx, detectIdx, detectDate, direction, tiers:{...} }
// entryIdx = index of the bar whose OPEN is used as entry (never the same bar used to detect).
// ========================================================================

function detectBodySlam(bars) {
  const out = [];
  for (let d = 20; d < bars.length - 1; d++) {
    const sma20 = mean(bars.slice(d - 19, d + 1).map(b => b.close));
    const stretchPct = ((bars[d].close - sma20) / sma20) * 100;
    if (Math.abs(stretchPct) < 6) continue;
    const prev = bars[d - 1];
    const bodyMin = Math.min(prev.open, prev.close), bodyMax = Math.max(prev.open, prev.close);
    let slamType = 'NONE';
    if (bars[d].close > bodyMax) slamType = 'SLAM LONG';
    else if (bars[d].close < bodyMin) slamType = 'SLAM SHORT';
    const direction = stretchPct <= -6 ? 'LONG' : 'SHORT';
    const confirmed = (direction === 'LONG' && slamType === 'SLAM LONG') || (direction === 'SHORT' && slamType === 'SLAM SHORT');
    out.push({
      entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction,
      tiers: { confirmed, extreme: Math.abs(stretchPct) >= 10 }
    });
  }
  return out;
}

function detectHiddenSmash(bars) {
  const out = [];
  for (let d = 20; d < bars.length - 1; d++) {
    const sma20 = mean(bars.slice(d - 19, d + 1).map(b => b.close));
    const stretchPct = ((bars[d].close - sma20) / sma20) * 100;
    const today = bars[d], yest = bars[d - 1];
    const bullTrap = today.high > yest.high && today.close < yest.high;
    const bearTrap = today.low < yest.low && today.close > yest.low;
    if (!bullTrap && !bearTrap) continue;
    const direction = bullTrap ? 'SHORT' : 'LONG';
    const stretchConfirms = bullTrap ? stretchPct >= 5 : stretchPct <= -5;
    out.push({
      entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction,
      tiers: { stretchConfirmed: stretchConfirms }
    });
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
    const direction = isValley ? 'LONG' : 'SHORT';
    const amplitude = Math.abs(c0 - c1) / c1 * 100;
    const volChange = bars[d - 1].volume > 0 ? ((bars[d].volume - bars[d - 1].volume) / bars[d - 1].volume) * 100 : 0;
    let confidence = 50;
    if (volChange > 0) { confidence += 15 + Math.min(volChange * 0.4, 15); confidence += Math.min(amplitude * 8, 15); }
    else { confidence -= isPeak ? 10 : 12; confidence -= Math.abs(volChange) * (isPeak ? 0.3 : 0.25); }
    confidence = Math.max(15, Math.min(95, Math.round(confidence)));
    out.push({
      entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction,
      tiers: { highConfidence: confidence >= 65 }
    });
  }
  return out;
}

function detectVolumina(bars) {
  const out = []; let unresolved = 0;
  for (let d = 5; d < bars.length - 1; d++) {
    const volToday = bars[d].volume, volYest = bars[d - 1].volume;
    if (!(volToday < volYest && volToday > 0)) continue;
    const avgVol5 = mean(bars.slice(d - 5, d).map(b => b.volume));
    const rVol = avgVol5 > 0 ? volToday / avgVol5 : null;
    const longLevel = bars[d].close * 1.01, shortLevel = bars[d].close * 0.99;
    let resolved = null;
    for (let j = d + 1; j <= Math.min(d + 10, bars.length - 2); j++) {
      if (bars[j].close > longLevel) { resolved = { idx: j, direction: 'LONG' }; break; }
      if (bars[j].close < shortLevel) { resolved = { idx: j, direction: 'SHORT' }; break; }
    }
    if (!resolved) { unresolved++; continue; }
    out.push({
      entryIdx: resolved.idx + 1, detectIdx: d, detectDate: bars[d].date, direction: resolved.direction,
      tiers: { tightRVol: rVol != null && rVol < 0.7, looseRVol: rVol != null && rVol < 1.0 }
    });
  }
  return { instances: out, unresolved };
}

function detectConsultusDaily(bars) {
  const out = []; let unresolved = 0;
  for (let d = 2; d < bars.length - 1; d++) {
    const A = bars[d].close, B = bars[d - 1].close, C = bars[d - 2].close;
    const diffAB = Math.abs(A - B), diffCB = Math.abs(C - B);
    if (!(diffAB < diffCB)) continue;
    const longTrigger = Math.max(A, B, C), shortTrigger = Math.min(A, B, C);
    let resolved = null;
    for (let j = d + 1; j <= Math.min(d + 10, bars.length - 2); j++) {
      if (bars[j].close > longTrigger) { resolved = { idx: j, direction: 'LONG' }; break; }
      if (bars[j].close < shortTrigger) { resolved = { idx: j, direction: 'SHORT' }; break; }
    }
    if (!resolved) { unresolved++; continue; }
    out.push({ entryIdx: resolved.idx + 1, detectIdx: d, detectDate: bars[d].date, direction: resolved.direction, tiers: {} });
  }
  return { instances: out, unresolved };
}

function detectConsultusWeekly(bars) {
  const weeks = buildWeeklyIndex(bars);
  const out = []; let unresolved = 0;
  for (let w = 2; w < weeks.length - 1; w++) {
    const A = weeks[w].close, B = weeks[w - 1].close, C = weeks[w - 2].close;
    const diffAB = Math.abs(A - B), diffCB = Math.abs(C - B);
    if (!(diffAB < diffCB)) continue;
    const longTrigger = Math.max(A, B, C), shortTrigger = Math.min(A, B, C);
    let resolved = null;
    for (let wj = w + 1; wj <= Math.min(w + 8, weeks.length - 1); wj++) {
      if (weeks[wj].close > longTrigger) { resolved = { w: wj, direction: 'LONG' }; break; }
      if (weeks[wj].close < shortTrigger) { resolved = { w: wj, direction: 'SHORT' }; break; }
    }
    if (!resolved) { unresolved++; continue; }
    const entryWeek = resolved.w + 1;
    if (entryWeek >= weeks.length) { unresolved++; continue; }
    const entryIdx = weeks[entryWeek].firstBarIdx;
    if (entryIdx >= bars.length - 1) continue;
    out.push({ entryIdx, detectIdx: weeks[w].lastBarIdx, detectDate: bars[weeks[w].lastBarIdx].date, direction: resolved.direction, tiers: {}, weekly: true });
  }
  return { instances: out, unresolved };
}

function detectCorpusParvus(bars) {
  const out = []; let unresolved = 0;
  for (let d = 2; d < bars.length - 1; d++) {
    const bodyA = Math.abs(bars[d - 1].close - bars[d - 1].open);
    const bodyB = Math.abs(bars[d].close - bars[d].open);
    if (!(bodyB < bodyA)) continue;
    const c0 = bars[d].close, c1 = bars[d - 1].close, c2 = bars[d - 2].close;
    let trend = 'Sideways';
    if (c0 > c1 && c1 > c2) trend = 'Bullish';
    else if (c0 < c1 && c1 < c2) trend = 'Bearish';
    const longBreakout = bars[d].close * 1.01, shortBreakout = bars[d].close * 0.99;
    let resolved = null;
    for (let j = d + 1; j <= Math.min(d + 10, bars.length - 2); j++) {
      if (bars[j].close > longBreakout) { resolved = { idx: j, direction: 'LONG' }; break; }
      if (bars[j].close < shortBreakout) { resolved = { idx: j, direction: 'SHORT' }; break; }
    }
    if (!resolved) { unresolved++; continue; }
    const aligned = (resolved.direction === 'LONG' && trend === 'Bullish') || (resolved.direction === 'SHORT' && trend === 'Bearish');
    out.push({ entryIdx: resolved.idx + 1, detectIdx: d, detectDate: bars[d].date, direction: resolved.direction, tiers: { trendAligned: aligned } });
  }
  return { instances: out, unresolved };
}

function detectDenarius(bars) {
  const out = [];
  for (let d = 2; d < bars.length - 1; d++) {
    const spread = bars[d].close / bars[d - 2].close;
    const direction = spread >= 1.0 ? 'LONG' : 'SHORT';
    const volTrend = bars[d - 1].volume > 0 ? ((bars[d].volume - bars[d - 1].volume) / bars[d - 1].volume) * 100 : 0;
    const hardLocked = volTrend <= 0;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction, tiers: { hardLocked, clean: !hardLocked } });
  }
  return out;
}

// Argentum needs cross-sectional universe context — built separately after per-symbol perf20 series.
function buildPerf20(bars) {
  const perf = new Array(bars.length).fill(null);
  for (let d = 20; d < bars.length; d++) {
    perf[d] = (bars[d].close - bars[d - 20].close) / bars[d - 20].close;
  }
  return perf;
}

// ========================================================================
// MAIN
// ========================================================================

const barsBySymbol = {};
for (const sym of symbols) barsBySymbol[sym] = cache[sym];

// --- Argentum: build cross-sectional universe mean perf20 per date ---
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
    let direction = null, tier = null;
    if (zScore <= -2.0) { direction = 'LONG'; tier = 'extreme'; }
    else if (zScore >= 2.0) { direction = 'SHORT'; tier = 'extreme'; }
    else if (zScore >= 0.75) { direction = 'LONG'; tier = 'trend'; }
    else if (zScore <= -0.75) { direction = 'SHORT'; tier = 'trend'; }
    if (!direction) continue;
    out.push({ entryIdx: d + 1, detectIdx: d, detectDate: bars[d].date, direction, tiers: { extreme: tier === 'extreme', trend: tier === 'trend' } });
  }
  return out;
}

// --- Run all detectors across all symbols ---
const raw = {
  argentum: [], bodySlam: [], hiddenSmash: [], peakValley: [], denarius: [],
  volumina: [], consultusDaily: [], consultusWeekly: [], corpusParvus: []
};
const unresolvedCounts = { volumina: 0, consultusDaily: 0, consultusWeekly: 0, corpusParvus: 0 };

for (const sym of symbols) {
  const bars = barsBySymbol[sym];
  const withSym = (arr) => arr.map(x => ({ sym, ...x }));

  raw.argentum.push(...withSym(detectArgentum(bars, perf20BySymbol[sym])));
  raw.bodySlam.push(...withSym(detectBodySlam(bars)));
  raw.hiddenSmash.push(...withSym(detectHiddenSmash(bars)));
  raw.peakValley.push(...withSym(detectPeakValley(bars)));
  raw.denarius.push(...withSym(detectDenarius(bars)));

  const vol = detectVolumina(bars); raw.volumina.push(...withSym(vol.instances)); unresolvedCounts.volumina += vol.unresolved;
  const cd = detectConsultusDaily(bars); raw.consultusDaily.push(...withSym(cd.instances)); unresolvedCounts.consultusDaily += cd.unresolved;
  const cw = detectConsultusWeekly(bars); raw.consultusWeekly.push(...withSym(cw.instances)); unresolvedCounts.consultusWeekly += cw.unresolved;
  const cp = detectCorpusParvus(bars); raw.corpusParvus.push(...withSym(cp.instances)); unresolvedCounts.corpusParvus += cp.unresolved;
}

// --- exit-rule sweep per logic ---
function computeExitVariants(sym, bars, entryIdx, direction, weekly) {
  if (entryIdx >= bars.length) return null;
  const variants = {};
  if (weekly) {
    const weeks = buildWeeklyIndex(bars);
    const entryWeekIdx = weeks.findIndex(w => w.firstBarIdx >= entryIdx);
    for (const wk of [1, 2, 4, 8]) {
      const key = 'horizon_' + wk + 'w';
      const targetWeek = entryWeekIdx + (wk - 1);
      if (entryWeekIdx < 0 || targetWeek >= weeks.length) { variants[key] = null; continue; }
      const exitIdx = weeks[targetWeek].lastBarIdx;
      const entry = bars[entryIdx].open, exitPrice = bars[exitIdx].close;
      const retPct = direction === 'LONG' ? ((exitPrice - entry) / entry) * 100 : ((entry - exitPrice) / entry) * 100;
      variants[key] = { retPct };
    }
    return variants;
  }
  for (const hd of [1, 3, 5, 10]) {
    const key = 'horizon_' + hd + 'd';
    if (entryIdx + hd - 1 >= bars.length) { variants[key] = null; continue; }
    variants[key] = fixedHorizon(bars, entryIdx, direction, hd);
  }
  if (entryIdx + MAX_HOLD_DAYS - 1 < bars.length) {
    variants.stop4pct_10d = applyMultiDayStop(bars, entryIdx, direction, MAX_HOLD_DAYS, STOP_PCT);
  } else variants.stop4pct_10d = null;
  return variants;
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

const LOGIC_META = {
  argentum: { weekly: false }, bodySlam: { weekly: false }, hiddenSmash: { weekly: false },
  peakValley: { weekly: false }, denarius: { weekly: false }, volumina: { weekly: false },
  consultusDaily: { weekly: false }, consultusWeekly: { weekly: true }, corpusParvus: { weekly: false }
};

for (const [logicName, instances] of Object.entries(raw)) {
  const bySym = {};
  for (const inst of instances) { if (!bySym[inst.sym]) bySym[inst.sym] = []; bySym[inst.sym].push(inst); }
  for (const sym of Object.keys(bySym)) attachSignalReversal(bySym[sym], barsBySymbol[sym]);

  for (const inst of instances) {
    const variants = computeExitVariants(inst.sym, barsBySymbol[inst.sym], inst.entryIdx, inst.direction, LOGIC_META[logicName].weekly);
    inst.exits = variants ? { ...variants, signal_reversal: inst.signalReversal } : { signal_reversal: inst.signalReversal };
  }
}

// --- summarize helper per exit rule, with robustness split ---
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

const DAILY_EXIT_KEYS = ['horizon_1d', 'horizon_3d', 'horizon_5d', 'horizon_10d', 'stop4pct_10d', 'signal_reversal'];
const WEEKLY_EXIT_KEYS = ['horizon_1w', 'horizon_2w', 'horizon_4w', 'horizon_8w', 'signal_reversal'];

function bestExitRule(exitRules) {
  let best = null;
  for (const [key, s] of Object.entries(exitRules)) {
    if (!s || !s.n) continue;
    if (!best || s.sharpeLike > best.sharpeLike) best = { key, ...s };
  }
  return best;
}

const output = { meta: {}, logics: {}, confluence: {} };

for (const [logicName, instances] of Object.entries(raw)) {
  const keys = LOGIC_META[logicName].weekly ? WEEKLY_EXIT_KEYS : DAILY_EXIT_KEYS;
  const exitRules = summarizeByExitRule(instances, keys);
  const best = bestExitRule(exitRules);

  const longInstances = instances.filter(i => i.direction === 'LONG');
  const shortInstances = instances.filter(i => i.direction === 'SHORT');

  const entry = {
    n: instances.length,
    long: { n: longInstances.length, exitRules: summarizeByExitRule(longInstances, keys) },
    short: { n: shortInstances.length, exitRules: summarizeByExitRule(shortInstances, keys) },
    exitRules,
    bestExitRule: best,
    unresolved: unresolvedCounts[logicName] != null ? unresolvedCounts[logicName] : undefined
  };

  // tier breakdowns (distinct per logic)
  const tierKeys = new Set();
  instances.forEach(i => Object.keys(i.tiers || {}).forEach(k => tierKeys.add(k)));
  if (tierKeys.size) {
    entry.tiers = {};
    for (const tk of tierKeys) {
      const subset = instances.filter(i => i.tiers[tk]);
      const complement = instances.filter(i => !i.tiers[tk]);
      entry.tiers[tk] = {
        trueCase: { n: subset.length, exitRules: summarizeByExitRule(subset, keys) },
        falseCase: { n: complement.length, exitRules: summarizeByExitRule(complement, keys) }
      };
    }
  }

  output.logics[logicName] = entry;
}

// --- Confluence test: fixed exit rule (horizon_5d + stop4pct_10d as the "balanced default") ---
const CONFLUENCE_EXIT_KEY = 'stop4pct_10d';
const directLogics = Object.keys(raw);
const bySymDay = new Map(); // key: sym|entryIdx -> [{logic, direction, retPct}]
for (const logicName of directLogics) {
  for (const inst of raw[logicName]) {
    if (!inst.exits[CONFLUENCE_EXIT_KEY]) continue;
    const key = inst.sym + '|' + inst.entryIdx;
    if (!bySymDay.has(key)) bySymDay.set(key, []);
    bySymDay.get(key).push({ logic: logicName, direction: inst.direction, retPct: inst.exits[CONFLUENCE_EXIT_KEY].retPct, detectDate: inst.detectDate });
  }
}

const tierTrades = { tier1: [], tier2: [], tier3plus: [] };
for (const [key, entries] of bySymDay.entries()) {
  const longs = entries.filter(e => e.direction === 'LONG');
  const shorts = entries.filter(e => e.direction === 'SHORT');
  for (const group of [longs, shorts]) {
    if (!group.length) continue;
    const avgRet = mean(group.map(e => e.retPct));
    const trade = { retPct: avgRet, detectDate: group[0].detectDate, agreeCount: group.length };
    if (group.length === 1) tierTrades.tier1.push(trade);
    else if (group.length === 2) tierTrades.tier2.push(trade);
    else tierTrades.tier3plus.push(trade);
  }
}
for (const [tier, trades] of Object.entries(tierTrades)) {
  const { older, newer } = splitHalves(trades);
  output.confluence[tier] = { ...summarize(trades), olderHalf: summarize(older), newerHalf: summarize(newer) };
}

output.meta = {
  symbols: symbols.length,
  dateRange: { from: barsBySymbol[symbols[0]][0].date, to: barsBySymbol[symbols[0]][barsBySymbol[symbols[0]].length - 1].date },
  stopPct: STOP_PCT,
  maxHoldDays: MAX_HOLD_DAYS,
  reversalCapDays: REVERSAL_CAP_DAYS,
  confluenceExitKey: CONFLUENCE_EXIT_KEY,
  generatedAt: new Date().toISOString()
};

fs.writeFileSync(path.join(__dirname, '..', 'data', 'novem-backtest-result.json'), JSON.stringify(output, null, 1));

console.log('=== SUMMARY (best exit rule per logic) ===');
for (const [name, entry] of Object.entries(output.logics)) {
  console.log(name, 'n=' + entry.n, 'unresolved=' + entry.unresolved, 'best=', entry.bestExitRule ? entry.bestExitRule.key + ' sharpeLike=' + entry.bestExitRule.sharpeLike + ' winRate=' + entry.bestExitRule.winRate + '% avgRet=' + entry.bestExitRule.avgRet + '% stopRate=' + entry.bestExitRule.stopRate + '%' : 'none');
}
console.log('\n=== CONFLUENCE TIERS ===');
for (const [tier, s] of Object.entries(output.confluence)) {
  console.log(tier, JSON.stringify(s));
}
