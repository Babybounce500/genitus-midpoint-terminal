// scripts/heikin-narrow-backtest.js
//
// User's own concept, formalized: "don't enter when the market is hot" -- wait for a narrow
// (quiet) Heikin-Ashi candle to enter IN the direction that candle already shows (continuation
// within a trend's pause, tested against its mirror-image reversal hypothesis too), then flatten
// as soon as a STRONG Heikin-Ashi candle appears in the position's own favorable direction
// (take the payoff, don't wait around through the volatility once it finally arrives).
//
// Precise rules (all choices explicit, nothing silently assumed):
//  - Heikin-Ashi bars computed from the real OHLC series (standard recursive formula).
//  - "Narrow" entry trigger = NR_N: this bar's HA range (HA-high - HA-low) is the smallest of
//    the last N HA bars. Tested at N=4 and N=7 (the classic NR4/NR7 convention).
//  - "Strong, favorable" exit trigger = WR_N: the first later bar whose HA range is the widest
//    of ITS last N HA bars AND whose own HA color matches the position's direction. Minimum
//    1 full bar held before this is even checked (lesson from the Markov-chain backtest: without
//    this floor, entry and exit can land on the same bar and fabricate a trivial "edge").
//  - Entry/exit PRICES are the real market open/close, never the synthetic HA price (HA is a
//    signal filter, not something you can actually place an order at).
//  - Both hypotheses tested: CONTINUATION (trade the narrow bar's own HA color) and REVERSAL
//    (trade the opposite) -- exactly like the Markov-chain backtest, let the data pick a winner
//    instead of assuming trend-following is correct.
//  - The user's own rule has NO adverse-move stop (it only ever exits on a favorable strong
//    candle) -- added here as a required safety-net comparison (stop4pct over the same cap
//    window), same convention as every other signal in this repo, so the report can show
//    honestly what happens to trades that never get a favorable strong candle.
//  - Same artifact check as before: the "strong favorable candle" exit is run in both its
//    close-exit and open-exit flavor, side by side, so a repeat of the signal_reversal bias
//    would be caught immediately rather than discovered after the fact.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const DAILY_CACHE = path.join(CACHE_DIR, 'novem-ohlc-cache.json');
const HOURLY_CACHE = path.join(CACHE_DIR, 'markov-hourly-cache.json');
const OUT = path.join(DATA_DIR, 'heikin-narrow-backtest-result.json');

const dailyRaw = JSON.parse(fs.readFileSync(DAILY_CACHE, 'utf8'));
const hourlyRaw = JSON.parse(fs.readFileSync(HOURLY_CACHE, 'utf8'));

// ---------- generic stats helpers (same convention as markov-chain-backtest.js) ----------
function mean(arr) { return arr.reduce((a, v) => a + v, 0) / arr.length; }
function stdev(arr, m) { if (arr.length < 2) return 0; const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1); return Math.sqrt(v); }
function summarize(trades, annFactor) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rets = trades.map(t => t.retPct);
  const avg = mean(rets);
  const sorted = rets.slice().sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = rets.filter(r => r > 0).length;
  const std = stdev(rets, avg);
  return {
    n, avgRet: +avg.toFixed(4), medianRet: +median.toFixed(4),
    winRate: +((wins / n) * 100).toFixed(2), stdDev: +std.toFixed(4),
    sharpeLike: std > 0 ? +((avg / std) * Math.sqrt(annFactor)).toFixed(3) : 0,
    worstTrade: +sorted[0].toFixed(2), bestTrade: +sorted[n - 1].toFixed(2)
  };
}
function splitHalves(trades) {
  const keys = [...new Set(trades.map(t => t.entryKey))].sort();
  if (!keys.length) return { older: [], newer: [] };
  const mid = keys[Math.floor(keys.length / 2)];
  return { older: trades.filter(t => t.entryKey < mid), newer: trades.filter(t => t.entryKey >= mid) };
}
function isRobust(stat) {
  if (!stat || !stat.olderHalf || !stat.newerHalf) return false;
  const o = stat.olderHalf, n = stat.newerHalf;
  if (!o.n || !n.n) return false;
  return o.sharpeLike > 0 && n.sharpeLike > 0 && n.sharpeLike >= o.sharpeLike * 0.5;
}
function bestOf(summaries, excludeKeys) {
  excludeKeys = excludeKeys || [];
  let best = null;
  for (const [key, s] of Object.entries(summaries)) {
    if (!s || !s.n || excludeKeys.includes(key)) continue;
    if (!best || s.sharpeLike > best.sharpeLike) best = { key, ...s };
  }
  return best;
}

// ---------- daily -> weekly / monthly resampling (same as markov-chain-backtest.js) ----------
function mondayKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
function monthKey(dateStr) { return dateStr.slice(0, 7); }
function resample(bars, keyFn) {
  const groups = new Map();
  for (const b of bars) { const k = keyFn(b.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const out = [];
  for (const [k, grp] of groups) out.push({ date: k, open: grp[0].open, high: Math.max(...grp.map(x => x.high)), low: Math.min(...grp.map(x => x.low)), close: grp[grp.length - 1].close });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function tagHourly(bars) {
  return bars.map(b => {
    const est = new Date(new Date(b.t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return { ...b, date: est.toISOString().slice(0, 10) + 'T' + String(est.getHours()).padStart(2, '0') + ':' + String(est.getMinutes()).padStart(2, '0') };
  });
}

// ---------- Heikin-Ashi ----------
function heikinAshi(bars) {
  const ha = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen = i === 0 ? (b.open + b.close) / 2 : (ha[i - 1].haOpen + ha[i - 1].haClose) / 2;
    const haHigh = Math.max(b.high, haOpen, haClose);
    const haLow = Math.min(b.low, haOpen, haClose);
    ha.push({ haOpen, haHigh, haLow, haClose, range: haHigh - haLow, dir: haClose >= haOpen ? 'G' : 'R' });
  }
  return ha;
}

// ---------- the engine ----------
function applyMultiDayStop(bars, entryIdx, direction, maxHold, stopPct) {
  const entry = bars[entryIdx].open;
  const lastIdx = Math.min(entryIdx + maxHold - 1, bars.length - 1);
  if (direction === 1) {
    const stopPrice = entry * (1 - stopPct / 100);
    for (let i = entryIdx; i <= lastIdx; i++) if (bars[i].low <= stopPrice) return { retPct: -stopPct, stopped: true };
    return { retPct: ((bars[lastIdx].close - entry) / entry) * 100, stopped: false };
  }
  const stopPrice = entry * (1 + stopPct / 100);
  for (let i = entryIdx; i <= lastIdx; i++) if (bars[i].high >= stopPrice) return { retPct: -stopPct, stopped: true };
  return { retPct: ((entry - bars[lastIdx].close) / entry) * 100, stopped: false };
}

const FIXED_EXIT_KEYS_BY_TF = {
  hourly: [{ key: 'horizon_1h', holdBars: 1 }, { key: 'horizon_3h', holdBars: 3 }, { key: 'horizon_5h', holdBars: 5 }, { key: 'horizon_10h', holdBars: 10 }],
  daily: [{ key: 'horizon_1d', holdBars: 1 }, { key: 'horizon_3d', holdBars: 3 }, { key: 'horizon_5d', holdBars: 5 }, { key: 'horizon_10d', holdBars: 10 }],
  weekly: [{ key: 'horizon_1w', holdBars: 1 }, { key: 'horizon_2w', holdBars: 2 }, { key: 'horizon_4w', holdBars: 4 }, { key: 'horizon_8w', holdBars: 8 }],
  monthly: [{ key: 'horizon_1m', holdBars: 1 }, { key: 'horizon_2m', holdBars: 2 }, { key: 'horizon_3m', holdBars: 3 }]
};
const STOP_BY_TF = { hourly: null, daily: { key: 'stop4pct_10d', holdBars: 10, stopPct: 4 }, weekly: null, monthly: null };
const CAP_BY_TF = { hourly: 20, daily: 20, weekly: 8, monthly: 6 };
const ANN_BY_TF = { hourly: 252 * 7, daily: 252, weekly: 52, monthly: 12 };

function runSymbol(bars, nrN, exitDefs, capBars, stopDef) {
  if (bars.length < Math.max(2 * nrN, 20)) return null;
  const ha = heikinAshi(bars);
  const pooled = { continuation: {}, reversal: {} };
  // 'strong_favorable' is the CORRECTED, reliable rule: once the trigger bar closes, act on it
  // at the NEXT bar's open -- same discipline already used for entries (never trade on the same
  // close that produced the signal). 'strong_favorable_naive_close'/'_naive_open' are the two
  // naive same-bar-price variants, kept ONLY to demonstrate the trap in the report (both turned
  // out contaminated: +0.62 Sharpe naive-close collapses to -7.3 naive-open on the same data --
  // selecting an exit bar by its own color/size is informative about that bar's own price action
  // no matter which of its own prices you then measure to).
  const exitKeys = [...exitDefs.map(d => d.key), 'strong_favorable', 'strong_favorable_naive_close', 'strong_favorable_naive_open'];
  if (stopDef) exitKeys.push(stopDef.key);
  for (const hyp of ['continuation', 'reversal']) for (const k of exitKeys) pooled[hyp][k] = [];

  let signals = 0;
  for (let t = nrN - 1; t < bars.length - 1; t++) {
    const window = ha.slice(t - nrN + 1, t + 1);
    const minRange = Math.min(...window.map(b => b.range));
    if (ha[t].range !== minRange) continue; // not a narrow-range bar
    signals++;

    const contDir = ha[t].dir === 'G' ? 1 : -1;
    const revDir = -contDir;
    const entryIdx = t + 1;
    const entryPrice = bars[entryIdx].open;
    const entryKey = bars[entryIdx].date;

    for (const def of exitDefs) {
      const exitIdx = Math.min(entryIdx + def.holdBars - 1, bars.length - 1);
      const rawRet = ((bars[exitIdx].close - entryPrice) / entryPrice) * 100;
      pooled.continuation[def.key].push({ retPct: contDir * rawRet, entryKey });
      pooled.reversal[def.key].push({ retPct: revDir * rawRet, entryKey });
    }
    if (stopDef) {
      const contRes = applyMultiDayStop(bars, entryIdx, contDir, stopDef.holdBars, stopDef.stopPct);
      const revRes = applyMultiDayStop(bars, entryIdx, revDir, stopDef.holdBars, stopDef.stopPct);
      pooled.continuation[stopDef.key].push({ retPct: contRes.retPct, entryKey, stopped: contRes.stopped });
      pooled.reversal[stopDef.key].push({ retPct: revRes.retPct, entryKey, stopped: revRes.stopped });
    }

    // "strong, favorable" search -- for EACH hypothesis's own direction, since "favorable" depends
    // on which way the position actually faces. Minimum 1 full bar held first (entryIdx itself is
    // never checked, scan starts at entryIdx+1) -- same fix as the Markov-chain backtest.
    for (const [hyp, dir] of [['continuation', contDir], ['reversal', revDir]]) {
      const wantColor = dir === 1 ? 'G' : 'R';
      let exitIdx = Math.min(entryIdx + 1, bars.length - 1);
      let found = false;
      for (let k = entryIdx + 1; k < Math.min(entryIdx + capBars, bars.length); k++) {
        if (k < nrN - 1) continue;
        const win = ha.slice(Math.max(0, k - nrN + 1), k + 1);
        const maxRange = Math.max(...win.map(b => b.range));
        exitIdx = k;
        if (ha[k].range === maxRange && ha[k].dir === wantColor) { found = true; break; }
      }
      // corrected: act on the confirmed trigger bar at the NEXT bar's open (never the trigger
      // bar's own price), same discipline as the entry rule.
      const confirmIdx = Math.min(exitIdx + 1, bars.length - 1);
      const retClean = dir * ((bars[confirmIdx].open - entryPrice) / entryPrice) * 100;
      const retNaiveClose = dir * ((bars[exitIdx].close - entryPrice) / entryPrice) * 100;
      const retNaiveOpen = dir * ((bars[exitIdx].open - entryPrice) / entryPrice) * 100;
      pooled[hyp].strong_favorable.push({ retPct: retClean, entryKey, unresolved: !found });
      pooled[hyp].strong_favorable_naive_close.push({ retPct: retNaiveClose, entryKey, unresolved: !found });
      pooled[hyp].strong_favorable_naive_open.push({ retPct: retNaiveOpen, entryKey, unresolved: !found });
    }
  }
  return { pooled, signals, exitKeys };
}

function summarizeExitKeys(trades, keys, annFactor) {
  const out = {};
  for (const key of keys) {
    const tr = trades[key] || [];
    const stopRate = tr.length && tr.some(t => t.stopped !== undefined) ? +((tr.filter(t => t.stopped).length / tr.length) * 100).toFixed(2) : undefined;
    const unresolvedRate = tr.length && tr.some(t => t.unresolved !== undefined) ? +((tr.filter(t => t.unresolved).length / tr.length) * 100).toFixed(2) : undefined;
    const { older, newer } = splitHalves(tr);
    out[key] = { ...summarize(tr, annFactor), olderHalf: summarize(older, annFactor), newerHalf: summarize(newer, annFactor) };
    if (stopRate !== undefined) out[key].stopRate = stopRate;
    if (unresolvedRate !== undefined) out[key].unresolvedRate = unresolvedRate;
  }
  return out;
}

function runTimeframeNR(tfName, barsBySymbol, nrN, annFactor) {
  const exitDefs = FIXED_EXIT_KEYS_BY_TF[tfName];
  const stopDef = STOP_BY_TF[tfName];
  const capBars = CAP_BY_TF[tfName];
  const exitKeys = [...exitDefs.map(d => d.key), 'strong_favorable', 'strong_favorable_naive_close', 'strong_favorable_naive_open'];
  if (stopDef) exitKeys.push(stopDef.key);

  const pooledAll = { continuation: {}, reversal: {} };
  for (const hyp of ['continuation', 'reversal']) for (const k of exitKeys) pooledAll[hyp][k] = [];

  let usedSymbols = 0, totalSignals = 0;
  const perSymbolTrades = {};
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    const r = runSymbol(bars, nrN, exitDefs, capBars, stopDef);
    if (!r) continue;
    usedSymbols++; totalSignals += r.signals;
    for (const hyp of ['continuation', 'reversal']) for (const k of exitKeys) pooledAll[hyp][k].push(...r.pooled[hyp][k]);
    perSymbolTrades[sym] = r.pooled;
  }

  const hypSummaries = { continuation: summarizeExitKeys(pooledAll.continuation, exitKeys, annFactor), reversal: summarizeExitKeys(pooledAll.reversal, exitKeys, annFactor) };
  // both naive same-bar-price variants are excluded from winner selection -- demonstrated
  // unreliable (see script header + report caveat), only 'strong_favorable' (next-bar-open
  // confirmation) is trusted here.
  const UNRELIABLE = ['strong_favorable_naive_close', 'strong_favorable_naive_open'];
  const contBest = bestOf(hypSummaries.continuation, UNRELIABLE);
  const revBest = bestOf(hypSummaries.reversal, UNRELIABLE);
  const winnerHyp = (revBest && (!contBest || revBest.sharpeLike > contBest.sharpeLike)) ? 'reversal' : 'continuation';
  const winnerBest = winnerHyp === 'reversal' ? revBest : contBest;

  const leaderboard = [];
  for (const [sym, trades] of Object.entries(perSymbolTrades)) {
    const tr = trades[winnerHyp][winnerBest.key] || [];
    if (tr.length < 10) continue;
    const { older, newer } = splitHalves(tr);
    const s = { ...summarize(tr, annFactor), olderHalf: summarize(older, annFactor), newerHalf: summarize(newer, annFactor) };
    leaderboard.push({ symbol: sym, ...s, robust: isRobust(s) });
  }
  leaderboard.sort((a, b) => b.sharpeLike - a.sharpeLike);

  return {
    name: tfName, nrN, usedSymbols, totalSignals,
    exitKeys, hypSummaries, winnerHyp, winnerBest,
    leaderboard: leaderboard.slice(0, 10).concat(leaderboard.length > 10 ? leaderboard.slice(-5) : []),
    leaderboardFullCount: leaderboard.length
  };
}

// ---------- build bar sets (reusing the exact caches from the Markov-chain backtest) ----------
const dailyBars = dailyRaw;
const weeklyBars = {}; for (const [sym, bars] of Object.entries(dailyRaw)) weeklyBars[sym] = resample(bars, mondayKey);
const monthlyBars = {}; for (const [sym, bars] of Object.entries(dailyRaw)) monthlyBars[sym] = resample(bars, monthKey);
const hourlyBars = {}; for (const [sym, bars] of Object.entries(hourlyRaw)) hourlyBars[sym] = tagHourly(bars);

const output = { meta: { generatedAt: new Date().toISOString(), universe: Object.keys(dailyRaw).length }, timeframes: {} };
for (const nrN of [4, 7]) {
  output.timeframes['hourly_nr' + nrN] = runTimeframeNR('hourly', hourlyBars, nrN, ANN_BY_TF.hourly);
  output.timeframes['daily_nr' + nrN] = runTimeframeNR('daily', dailyBars, nrN, ANN_BY_TF.daily);
  output.timeframes['weekly_nr' + nrN] = runTimeframeNR('weekly', weeklyBars, nrN, ANN_BY_TF.weekly);
  output.timeframes['monthly_nr' + nrN] = runTimeframeNR('monthly', monthlyBars, nrN, ANN_BY_TF.monthly);
}

fs.writeFileSync(OUT, JSON.stringify(output));
console.log('Saved to', OUT);
for (const [key, tf] of Object.entries(output.timeframes)) {
  const w = tf.winnerBest;
  console.log(key, '| signals:', tf.totalSignals, '| winner:', tf.winnerHyp, w.key, '| sharpe:', w.sharpeLike, '| winRate:', w.winRate, '| n:', w.n, '| robust?', isRobust(w));
}
