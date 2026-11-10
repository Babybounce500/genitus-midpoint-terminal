// scripts/markov-chain-backtest.js
//
// Backtests the 2-state Markov-chain edge (state = bar's own body direction, close>=open)
// that powers the live "Intraday Markov" tab in KOMMANDOZENTRALE-V2.html, across FOUR
// timeframes: Hourly, Daily, Weekly, Monthly. For every timeframe it tests BOTH possible
// trading hypotheses -- CONTINUATION (trade the same direction as the just-closed bar) and
// REVERSAL (trade the opposite direction) -- against an exit-rule sweep, pooled across the
// same 52-symbol universe used by the NOVEM-Suite backtest (daily cache reused; weekly/
// monthly resampled from it; hourly fetched separately via markov-chain-fetch-hourly.js).
//
// Methodology, matching the house convention already used by novem-backtest.js /
// pivot-daily-backtest.js:
//  - Entry at the NEXT bar's open (never the same close that produced the signal).
//  - Direction is tested UNIFORMLY across the whole universe per hypothesis (no per-symbol
//    direction cherry-picking) -- this is the primary, de-risked test.
//  - Two-period robustness split (older/newer half by entry date), isRobust() requires both
//    halves sharpe-like > 0 AND newer >= older * 0.5 (same rule used throughout this repo).
//  - Supplementary: per-symbol Shannon-entropy "quality" tag (PATTERN <0.75 bits vs NOISE),
//    same formula and threshold as the live tab, tested as its own tier (does the entropy
//    filter actually predict a stronger edge, or is it cosmetic).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const DAILY_CACHE = path.join(CACHE_DIR, 'novem-ohlc-cache.json');
const HOURLY_CACHE = path.join(CACHE_DIR, 'markov-hourly-cache.json');
const OUT = path.join(DATA_DIR, 'markov-chain-backtest-result.json');

const dailyRaw = JSON.parse(fs.readFileSync(DAILY_CACHE, 'utf8'));
const hourlyRaw = JSON.parse(fs.readFileSync(HOURLY_CACHE, 'utf8'));

// ---------- generic stats helpers (same convention as novem-backtest.js) ----------
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
    n,
    avgRet: +avg.toFixed(4),
    medianRet: +median.toFixed(4),
    winRate: +((wins / n) * 100).toFixed(2),
    stdDev: +std.toFixed(4),
    sharpeLike: std > 0 ? +((avg / std) * Math.sqrt(annFactor)).toFixed(3) : 0,
    worstTrade: +sorted[0].toFixed(2),
    bestTrade: +sorted[n - 1].toFixed(2)
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

// ---------- daily -> weekly / monthly resampling ----------
function mondayKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
function monthKey(dateStr) { return dateStr.slice(0, 7); }

function resample(bars, keyFn) {
  const groups = new Map();
  for (const b of bars) {
    const k = keyFn(b.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const out = [];
  for (const [k, grp] of groups) {
    out.push({ date: k, open: grp[0].open, high: Math.max(...grp.map(x => x.high)), low: Math.min(...grp.map(x => x.low)), close: grp[grp.length - 1].close });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- hourly bars: tag with an entry key (date+hour) for the robustness split ----------
function tagHourly(bars) {
  return bars.map(b => {
    const est = new Date(new Date(b.t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dateKey = est.toISOString().slice(0, 10) + 'T' + String(est.getHours()).padStart(2, '0') + ':' + String(est.getMinutes()).padStart(2, '0');
    return { ...b, date: dateKey };
  });
}

// ---------- Shannon entropy "quality" tag (same formula/threshold as the live tab) ----------
function entropyQuality(bars) {
  const states = bars.map(b => (b.close >= b.open) ? 'G' : 'R');
  let ggHit = 0, ggTotal = 0, rgHit = 0, rgTotal = 0;
  for (let i = 0; i < states.length - 1; i++) {
    if (states[i] === 'G') { ggTotal++; if (states[i + 1] === 'G') ggHit++; }
    else { rgTotal++; if (states[i + 1] === 'G') rgHit++; }
  }
  const pGG = ggTotal ? ggHit / ggTotal : 0.5;
  const pGR = rgTotal ? rgHit / rgTotal : 0.5;
  const binEntropy = p => (p <= 0 || p >= 1) ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
  const avgEntropy = (binEntropy(pGG) + binEntropy(pGR)) / 2;
  return { pGG: +pGG.toFixed(4), pGR: +pGR.toFixed(4), entropy: +avgEntropy.toFixed(4), quality: avgEntropy < 0.75 ? 'PATTERN' : 'NOISE' };
}

// ---------- the generic backtest engine (runs identically on any OHLC bar array) ----------
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

function runSymbol(bars, exitDefs, reversalCapBars, stopDef) {
  if (bars.length < 20) return null;
  const states = bars.map(b => (b.close >= b.open) ? 'G' : 'R');
  const pooled = { continuation: {}, reversal: {} };
  // 'signal_reversal' exits at the CLOSE of the stopping bar -- that close is, by construction,
  // the very condition that ended the hold, which structurally biases the exit toward a locally
  // favorable price (confirmed empirically: hourly win rate collapses from 67% to 3% once the
  // exit price is swapped to that same bar's OPEN). 'signal_reversal_open' is the bias-free
  // control variant, reported side by side rather than silently assumed away.
  const keys = [...exitDefs.map(d => d.key), 'signal_reversal', 'signal_reversal_open'];
  if (stopDef) keys.push(stopDef.key);
  for (const hyp of ['continuation', 'reversal']) for (const k of keys) pooled[hyp][k] = [];

  for (let t = 0; t < bars.length - 1; t++) {
    const state = states[t];
    const contDir = state === 'G' ? 1 : -1;
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

    // Minimum 1 full bar held before a flip can even be checked -- without this floor, a position
    // whose very first bar already differs from state(t) exits at its own entry price (open ==
    // open), producing a pile of exact-zero "trades" that silently deflate the measured variance
    // and inflate sharpeLike. Caught empirically (median return was landing on exactly 0).
    let exitIdx = Math.min(entryIdx + 1, bars.length - 1);
    for (let k = entryIdx + 1; k < Math.min(entryIdx + reversalCapBars, bars.length); k++) { exitIdx = k; if (states[k] !== state) break; }
    const rawRet2 = ((bars[exitIdx].close - entryPrice) / entryPrice) * 100;
    const rawRet2Open = ((bars[exitIdx].open - entryPrice) / entryPrice) * 100;
    pooled.continuation.signal_reversal.push({ retPct: contDir * rawRet2, entryKey });
    pooled.reversal.signal_reversal.push({ retPct: revDir * rawRet2, entryKey });
    pooled.continuation.signal_reversal_open.push({ retPct: contDir * rawRet2Open, entryKey });
    pooled.reversal.signal_reversal_open.push({ retPct: revDir * rawRet2Open, entryKey });
  }
  return pooled;
}

function summarizeExitKeys(trades, keys, annFactor) {
  const out = {};
  for (const key of keys) {
    const tr = trades[key] || [];
    const stopRate = tr.length && tr.some(t => t.stopped !== undefined) ? +((tr.filter(t => t.stopped).length / tr.length) * 100).toFixed(2) : undefined;
    const { older, newer } = splitHalves(tr);
    out[key] = { ...summarize(tr, annFactor), olderHalf: summarize(older, annFactor), newerHalf: summarize(newer, annFactor) };
    if (stopRate !== undefined) out[key].stopRate = stopRate;
  }
  return out;
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

function runTimeframe(name, barsBySymbol, exitDefs, reversalCapBars, annFactor, stopDef) {
  const exitKeys = [...exitDefs.map(d => d.key), 'signal_reversal', 'signal_reversal_open'];
  if (stopDef) exitKeys.push(stopDef.key);

  const pooledAll = { continuation: {}, reversal: {} };
  for (const hyp of ['continuation', 'reversal']) for (const k of exitKeys) pooledAll[hyp][k] = [];

  const perSymbol = {};
  let usedSymbols = 0;
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    const pooled = runSymbol(bars, exitDefs, reversalCapBars, stopDef);
    if (!pooled) continue;
    usedSymbols++;
    perSymbol[sym] = { quality: entropyQuality(bars), n: bars.length - 1 };
    for (const hyp of ['continuation', 'reversal']) for (const k of exitKeys) pooledAll[hyp][k].push(...pooled[hyp][k]);

    // keep each symbol's own summary too, for the per-symbol leaderboard (uses the SAME
    // hypothesis that wins universe-wide once known -- filled in below after the pooled pass).
    perSymbol[sym]._trades = pooled;
  }

  const hypSummaries = { continuation: summarizeExitKeys(pooledAll.continuation, exitKeys, annFactor), reversal: summarizeExitKeys(pooledAll.reversal, exitKeys, annFactor) };

  // "naive" winner: best sharpe-like across ALL exit rules, including the close-exit
  // signal_reversal variant that is structurally biased toward a favorable exit price.
  const contBestNaive = bestOf(hypSummaries.continuation);
  const revBestNaive = bestOf(hypSummaries.reversal);
  const winnerHypNaive = (revBestNaive && (!contBestNaive || revBestNaive.sharpeLike > contBestNaive.sharpeLike)) ? 'reversal' : 'continuation';
  const winnerBestNaive = winnerHypNaive === 'reversal' ? revBestNaive : contBestNaive;

  // "clean" winner: same search, but excluding BOTH signal_reversal variants -- for this signal
  // type (where every single bar emits a state, unlike NOVEM's sparser detectors) "hold until
  // the opposite bar color appears" is a self-referential, noisy rule in either exit-price flavor.
  // This is the one used for the leaderboard and the headline verdict, precisely so a structural
  // artifact can't masquerade as a real edge.
  const contBest = bestOf(hypSummaries.continuation, ['signal_reversal', 'signal_reversal_open']);
  const revBest = bestOf(hypSummaries.reversal, ['signal_reversal', 'signal_reversal_open']);
  const winnerHyp = (revBest && (!contBest || revBest.sharpeLike > contBest.sharpeLike)) ? 'reversal' : 'continuation';
  const winnerBest = winnerHyp === 'reversal' ? revBest : contBest;

  // per-symbol leaderboard using the universe-wide winning hypothesis + exit rule (fixed rule,
  // not re-optimized per symbol -- avoids direction cherry-picking at the symbol level)
  const leaderboard = [];
  for (const [sym, entry] of Object.entries(perSymbol)) {
    const tr = entry._trades[winnerHyp][winnerBest.key] || [];
    if (tr.length < 10) continue;
    const { older, newer } = splitHalves(tr);
    const s = { ...summarize(tr, annFactor), olderHalf: summarize(older, annFactor), newerHalf: summarize(newer, annFactor) };
    leaderboard.push({ symbol: sym, quality: entry.quality.quality, entropy: entry.quality.entropy, ...s, robust: isRobust(s) });
    delete entry._trades;
  }
  leaderboard.sort((a, b) => b.sharpeLike - a.sharpeLike);

  // entropy-quality tier test: does PATTERN (low entropy) actually predict a stronger edge
  // than NOISE, using the SAME fixed winning hypothesis+exit rule?
  const patternSyms = new Set(Object.entries(perSymbol).filter(([, e]) => e.quality.quality === 'PATTERN').map(([s]) => s));
  const patternTrades = [], noiseTrades = [];
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    const pooled = runSymbol(bars, exitDefs, reversalCapBars, stopDef);
    if (!pooled) continue;
    const tr = pooled[winnerHyp][winnerBest.key] || [];
    (patternSyms.has(sym) ? patternTrades : noiseTrades).push(...tr);
  }
  const patternStat = summarize(patternTrades, annFactor);
  const noiseStat = summarize(noiseTrades, annFactor);

  return {
    name, usedSymbols,
    exitKeys,
    hypSummaries,
    winnerHyp, winnerBest,
    winnerHypNaive, winnerBestNaive,
    leaderboard: leaderboard.slice(0, 10).concat(leaderboard.length > 10 ? leaderboard.slice(-5) : []),
    leaderboardFullCount: leaderboard.length,
    qualityTier: { pattern: { n: patternSyms.size, ...patternStat }, noise: { n: Object.keys(perSymbol).length - patternSyms.size, ...noiseStat } }
  };
}

// ---------- build bar sets ----------
const dailyBars = dailyRaw;
const weeklyBars = {}; for (const [sym, bars] of Object.entries(dailyRaw)) weeklyBars[sym] = resample(bars, mondayKey);
const monthlyBars = {}; for (const [sym, bars] of Object.entries(dailyRaw)) monthlyBars[sym] = resample(bars, monthKey);
const hourlyBars = {}; for (const [sym, bars] of Object.entries(hourlyRaw)) hourlyBars[sym] = tagHourly(bars);

// ---------- exit rule defs per timeframe ----------
const HOURLY_EXITS = [{ key: 'horizon_1h', holdBars: 1 }, { key: 'horizon_3h', holdBars: 3 }, { key: 'horizon_5h', holdBars: 5 }, { key: 'horizon_10h', holdBars: 10 }];
const DAILY_EXITS = [{ key: 'horizon_1d', holdBars: 1 }, { key: 'horizon_3d', holdBars: 3 }, { key: 'horizon_5d', holdBars: 5 }, { key: 'horizon_10d', holdBars: 10 }];
const WEEKLY_EXITS = [{ key: 'horizon_1w', holdBars: 1 }, { key: 'horizon_2w', holdBars: 2 }, { key: 'horizon_4w', holdBars: 4 }, { key: 'horizon_8w', holdBars: 8 }];
const MONTHLY_EXITS = [{ key: 'horizon_1m', holdBars: 1 }, { key: 'horizon_2m', holdBars: 2 }, { key: 'horizon_3m', holdBars: 3 }];
const DAILY_STOP = { key: 'stop4pct_10d', holdBars: 10, stopPct: 4 };

const output = { meta: { generatedAt: new Date().toISOString(), universe: Object.keys(dailyRaw).length }, timeframes: {} };

output.timeframes.hourly = runTimeframe('Stündlich', hourlyBars, HOURLY_EXITS, 20, 252 * 7);
output.timeframes.daily = runTimeframe('Täglich', dailyBars, DAILY_EXITS, 20, 252, DAILY_STOP);
output.timeframes.weekly = runTimeframe('Wöchentlich', weeklyBars, WEEKLY_EXITS, 8, 52);
output.timeframes.monthly = runTimeframe('Monatlich', monthlyBars, MONTHLY_EXITS, 6, 12);

fs.writeFileSync(OUT, JSON.stringify(output));
console.log('Saved to', OUT);
for (const [key, tf] of Object.entries(output.timeframes)) {
  console.log('---', key, '---');
  console.log('CLEAN  winner:', tf.winnerHyp, tf.winnerBest.key, '| sharpeLike:', tf.winnerBest.sharpeLike, '| winRate:', tf.winnerBest.winRate, '| n:', tf.winnerBest.n, '| robust?', isRobust(tf.winnerBest));
  console.log('NAIVE  winner:', tf.winnerHypNaive, tf.winnerBestNaive.key, '| sharpeLike:', tf.winnerBestNaive.sharpeLike, '| winRate:', tf.winnerBestNaive.winRate, '| n:', tf.winnerBestNaive.n, '| robust?', isRobust(tf.winnerBestNaive));
  console.log('pattern vs noise sharpe (clean winner rule):', tf.qualityTier.pattern.sharpeLike, 'vs', tf.qualityTier.noise.sharpeLike, '| pattern n:', tf.qualityTier.pattern.n);
}
