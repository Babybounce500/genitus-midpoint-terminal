// scripts/tempo-trader-backtest.js
//
// Backtests the TEMPO TRADER concept (TEMPO-TRADER.html): Tempo[t] = |Close[t]-Close[t-1]| -
// |Close[t-1]-Close[t-2]| (deceleration/acceleration of absolute daily move size). Entry signal:
// Tempo[t] < 0 (market decelerating) AND Close[t] vs SMA20[t] gives direction (above -> LONG,
// below -> SHORT); Tempo[t] >= 0 -> no trade (matches the live tool's own logic exactly).
//
// Two bugs in the live tool are fixed here rather than replicated, same house policy as every
// other backtest in this repo:
//   1. Live tool's "entry" is TODAY's own high/low -- not achievable (today is already over by
//      the time the signal, which needs today's close, can be computed). Backtest entry = next
//      day's open, the standard, achievable convention used everywhere else in this repo.
//   2. Live tool's stop is a fixed 1-point distance, nonsensical across instruments at different
//      price levels -- tested here BOTH literally (to quantify how broken it is) AND as a
//      sensible percentage-based stand-in, clearly labeled apart.
//
// The live tool's "STOP MANAGER" (break-even after first winning candle, trail from the second)
// is pure UI decoration in the actual code -- no JS ever moves the stop. It's given a REAL,
// honest implementation here (own exit rule, bar-by-bar simulation) so the underlying idea gets
// tested on its own merits instead of being dismissed for the live tool's incompleteness.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DAILY_CACHE = path.join(DATA_DIR, '.cache', 'novem-ohlc-cache.json');
const OUT = path.join(DATA_DIR, 'tempo-trader-backtest-result.json');
const dailyRaw = JSON.parse(fs.readFileSync(DAILY_CACHE, 'utf8'));

// ---------- generic stats helpers (same convention as every other backtest here) ----------
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
function bestOf(summaries) {
    let best = null;
    for (const [key, s] of Object.entries(summaries)) {
        if (!s || !s.n) continue;
        if (!best || s.sharpeLike > best.sharpeLike) best = { key, ...s };
    }
    return best;
}
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

const ANN_FACTOR = 252;
const CAP_BARS = 20;

// ---------- indicator math ----------
function calcSMA(closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) out[i] = mean(closes.slice(i - period + 1, i + 1));
    return out;
}
function calcTempo(closes) {
    const out = new Array(closes.length).fill(null);
    for (let i = 2; i < closes.length; i++) out[i] = Math.abs(closes[i] - closes[i - 1]) - Math.abs(closes[i - 1] - closes[i - 2]);
    return out;
}

// ---------- the real "stop manager" the live tool only describes but never codes ----------
// Initial stop 1% (percentage stand-in for the live tool's broken fixed "1 point"). After the
// first bar that closes beyond entry in the trade's favor -> stop to breakeven (effective from
// the NEXT bar, never retroactively). From the second such favorable-close bar onward -> trail
// the stop to just under/over that bar's own low/high (never loosened). Capped at CAP_BARS.
function simulateStopManager(bars, entryIdx, dir, initialStopPct) {
    const entry = bars[entryIdx].open;
    let stop = dir === 1 ? entry * (1 - initialStopPct / 100) : entry * (1 + initialStopPct / 100);
    let favorableCount = 0;
    const lastIdx = Math.min(entryIdx + CAP_BARS - 1, bars.length - 1);
    for (let i = entryIdx; i <= lastIdx; i++) {
        const b = bars[i];
        // check stop first (using the CURRENT stop, set by the end of the PRIOR bar)
        if (dir === 1) {
            if (b.open < stop) return { retPct: ((b.open - entry) / entry) * 100, stopped: true, bars: i - entryIdx + 1 };
            if (b.low <= stop) return { retPct: ((stop - entry) / entry) * 100, stopped: true, bars: i - entryIdx + 1 };
        } else {
            if (b.open > stop) return { retPct: ((entry - b.open) / entry) * 100, stopped: true, bars: i - entryIdx + 1 };
            if (b.high >= stop) return { retPct: ((entry - stop) / entry) * 100, stopped: true, bars: i - entryIdx + 1 };
        }
        // update stop for the NEXT bar based on THIS bar's close/extremes (no lookahead)
        const favorable = dir === 1 ? b.close > entry : b.close < entry;
        if (favorable) {
            favorableCount++;
            if (favorableCount === 1) {
                stop = dir === 1 ? Math.max(stop, entry) : Math.min(stop, entry); // breakeven
            } else {
                stop = dir === 1 ? Math.max(stop, b.low) : Math.min(stop, b.high); // trail
            }
        }
    }
    const retPct = dir === 1 ? ((bars[lastIdx].close - entry) / entry) * 100 : ((entry - bars[lastIdx].close) / entry) * 100;
    return { retPct, stopped: false, bars: lastIdx - entryIdx + 1 };
}

// ---------- per-symbol run ----------
function runSymbol(bars) {
    if (bars.length < 40) return null;
    const closes = bars.map(b => b.close);
    const sma20 = calcSMA(closes, 20);
    const tempo = calcTempo(closes);

    const exitKeys = ['horizon_1d', 'horizon_3d', 'horizon_5d', 'horizon_10d', 'stop4pct_10d', 'fixed1pt_stop', 'stopmanager_1pct'];
    const pooled = { follow: {}, fade: {} };
    for (const hyp of ['follow', 'fade']) for (const k of exitKeys) pooled[hyp][k] = [];
    let signals = 0;

    for (let t = 20; t < bars.length - 1; t++) {
        if (tempo[t] == null || sma20[t] == null) continue;
        if (!(tempo[t] < 0)) continue; // live tool: only "decelerating" days ever produce a signal
        const followDir = bars[t].close > sma20[t] ? 1 : -1;
        const fadeDir = -followDir;
        const entryIdx = t + 1;
        const entryPrice = bars[entryIdx].open;
        const entryKey = bars[entryIdx].date;
        signals++;

        for (const hold of [1, 3, 5, 10]) {
            const exitIdx = Math.min(entryIdx + hold - 1, bars.length - 1);
            const rawRet = ((bars[exitIdx].close - entryPrice) / entryPrice) * 100;
            pooled.follow['horizon_' + hold + 'd'].push({ retPct: followDir * rawRet, entryKey });
            pooled.fade['horizon_' + hold + 'd'].push({ retPct: fadeDir * rawRet, entryKey });
        }
        const followStop = applyMultiDayStop(bars, entryIdx, followDir, 10, 4);
        const fadeStop = applyMultiDayStop(bars, entryIdx, fadeDir, 10, 4);
        pooled.follow.stop4pct_10d.push({ retPct: followStop.retPct, entryKey, stopped: followStop.stopped });
        pooled.fade.stop4pct_10d.push({ retPct: fadeStop.retPct, entryKey, stopped: fadeStop.stopped });

        // literal live-tool stop: fixed 1 currency-unit distance, no time cap specified by the
        // tool itself beyond the decorative "5 candles" -- apply that cap here since it's the
        // only number the tool actually names.
        for (const [hyp, dir] of [['follow', followDir], ['fade', fadeDir]]) {
            const stopPrice = dir === 1 ? entryPrice - 1 : entryPrice + 1;
            let exitIdx = Math.min(entryIdx + 4, bars.length - 1), stopped = false, exitPrice = null;
            for (let i = entryIdx; i <= exitIdx; i++) {
                if (dir === 1 && bars[i].low <= stopPrice) { stopped = true; exitPrice = Math.min(bars[i].open, stopPrice); exitIdx = i; break; }
                if (dir === -1 && bars[i].high >= stopPrice) { stopped = true; exitPrice = Math.max(bars[i].open, stopPrice); exitIdx = i; break; }
            }
            if (!stopped) exitPrice = bars[exitIdx].close;
            const retPct = dir * ((exitPrice - entryPrice) / entryPrice) * 100;
            pooled[hyp].fixed1pt_stop.push({ retPct, entryKey, stopped });
        }

        // the REAL stop-manager (breakeven + trail), properly implemented, both directions
        for (const [hyp, dir] of [['follow', followDir], ['fade', fadeDir]]) {
            const sim = simulateStopManager(bars, entryIdx, dir, 1);
            pooled[hyp].stopmanager_1pct.push({ retPct: sim.retPct, entryKey, stopped: sim.stopped });
        }
    }
    return { pooled, exitKeys, signals };
}

function summarizeKeys(trades, exitKeys, annFactor) {
    const out = {};
    for (const key of exitKeys) {
        const tr = trades[key] || [];
        const stopRate = tr.length && tr.some(t => t.stopped !== undefined) ? +((tr.filter(t => t.stopped).length / tr.length) * 100).toFixed(2) : undefined;
        const { older, newer } = splitHalves(tr);
        out[key] = { ...summarize(tr, annFactor), olderHalf: summarize(older, annFactor), newerHalf: summarize(newer, annFactor) };
        if (stopRate !== undefined) out[key].stopRate = stopRate;
    }
    return out;
}

const perSymbol = {};
let usedSymbols = 0, totalSignals = 0;
let exitKeysGlobal = null;
const pooledAll = { follow: {}, fade: {} };

for (const [sym, bars] of Object.entries(dailyRaw)) {
    const r = runSymbol(bars);
    if (!r) continue;
    usedSymbols++; totalSignals += r.signals;
    if (!exitKeysGlobal) { exitKeysGlobal = r.exitKeys; for (const hyp of ['follow', 'fade']) for (const k of exitKeysGlobal) pooledAll[hyp][k] = []; }
    for (const hyp of ['follow', 'fade']) for (const k of exitKeysGlobal) pooledAll[hyp][k].push(...r.pooled[hyp][k]);
    perSymbol[sym] = r.pooled;
}

const hypSummaries = { follow: summarizeKeys(pooledAll.follow, exitKeysGlobal, ANN_FACTOR), fade: summarizeKeys(pooledAll.fade, exitKeysGlobal, ANN_FACTOR) };
const followBest = bestOf(hypSummaries.follow);
const fadeBest = bestOf(hypSummaries.fade);
const winnerHyp = (fadeBest && (!followBest || fadeBest.sharpeLike > followBest.sharpeLike)) ? 'fade' : 'follow';
const winnerBest = winnerHyp === 'fade' ? fadeBest : followBest;

// quantify how broken the literal fixed-1-point stop is: distribution of (1 / price) as a % risk
const priceLevels = [];
for (const bars of Object.values(dailyRaw)) priceLevels.push(bars[bars.length - 1].close);
priceLevels.sort((a, b) => a - b);
const pctOfOnePoint = priceLevels.map(p => +(100 / p).toFixed(3));

const leaderboard = [];
for (const [sym, pooled] of Object.entries(perSymbol)) {
    const tr = pooled[winnerHyp][winnerBest.key] || [];
    if (tr.length < 8) continue;
    const { older, newer } = splitHalves(tr);
    const s = { ...summarize(tr, ANN_FACTOR), olderHalf: summarize(older, ANN_FACTOR), newerHalf: summarize(newer, ANN_FACTOR) };
    leaderboard.push({ symbol: sym, ...s, robust: isRobust(s) });
}
leaderboard.sort((a, b) => b.sharpeLike - a.sharpeLike);

const output = {
    meta: { generatedAt: new Date().toISOString(), universe: Object.keys(dailyRaw).length, usedSymbols, totalSignals },
    exitKeys: exitKeysGlobal, hypSummaries, winnerHyp, winnerBest,
    fixedStopDistortion: { minPct: pctOfOnePoint[0], maxPct: pctOfOnePoint[pctOfOnePoint.length - 1], medianPct: pctOfOnePoint[Math.floor(pctOfOnePoint.length / 2)] },
    leaderboard: leaderboard.slice(0, 10).concat(leaderboard.length > 10 ? leaderboard.slice(-5) : []),
    leaderboardFullCount: leaderboard.length
};
fs.writeFileSync(OUT, JSON.stringify(output));
console.log('Saved to', OUT);
console.log('symbols:', usedSymbols, '| signals:', totalSignals, '| winner:', winnerHyp, winnerBest.key, '| sharpe:', winnerBest.sharpeLike, '| winRate:', winnerBest.winRate, '| n:', winnerBest.n, '| robust?', isRobust(winnerBest));
console.log('fixed 1-point stop as % of price: min=' + output.fixedStopDistortion.minPct + '% median=' + output.fixedStopDistortion.medianPct + '% max=' + output.fixedStopDistortion.maxPct + '%');
console.log('\nall exit rules (follow / fade):');
for (const k of exitKeysGlobal) {
    const f = hypSummaries.follow[k], fa = hypSummaries.fade[k];
    if (f?.n) console.log('follow', k, 'n=' + f.n, 'sharpe=' + f.sharpeLike, 'winRate=' + f.winRate, 'robust=' + isRobust(f));
    if (fa?.n) console.log('fade  ', k, 'n=' + fa.n, 'sharpe=' + fa.sharpeLike, 'winRate=' + fa.winRate, 'robust=' + isRobust(fa));
}
