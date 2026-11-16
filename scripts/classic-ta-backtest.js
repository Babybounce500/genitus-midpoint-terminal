// scripts/classic-ta-backtest.js
//
// Backtests three classic, widely-used technical-analysis methods the user asked for by name
// ("breakout, donchian, RSI etc"): Donchian Channel Breakout (the classic Turtle-Trading rule --
// "breakout" and "Donchian" are the same thing), RSI(14) oversold/overbought, and MACD(12,26,9)
// crossover. Same rigor as every other backtest in this repo: entry at next open, exit-rule
// sweep, two-period robustness split, same 52-symbol/3-year universe. Each method is tested in
// BOTH its textbook direction ("follow") and the contrarian mirror ("fade") -- don't assume the
// textbook convention is correct, let the data say so, same discipline as NOVEM/Markov-chain/
// Heikin-Narrow. Every exit that depends on a signal flip is confirmed on the flip bar, then
// executed at the NEXT bar's open -- never the flip bar's own price -- precisely because the
// Markov-chain and Heikin-Narrow backtests both found that same-bar exit pricing fabricates a
// fake edge out of pure selection bias.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DAILY_CACHE = path.join(DATA_DIR, '.cache', 'novem-ohlc-cache.json');
const OUT = path.join(DATA_DIR, 'classic-ta-backtest-result.json');
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
function bestOf(summaries, excludeKeys) {
    excludeKeys = excludeKeys || [];
    let best = null;
    for (const [key, s] of Object.entries(summaries)) {
        if (!s || !s.n || excludeKeys.includes(key)) continue;
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

const DAILY_EXITS = [{ key: 'horizon_1d', holdBars: 1 }, { key: 'horizon_3d', holdBars: 3 }, { key: 'horizon_5d', holdBars: 5 }, { key: 'horizon_10d', holdBars: 10 }];
const STOP_DEF = { key: 'stop4pct_10d', holdBars: 10, stopPct: 4 };
const CAP_BARS = 20;
const ANN_FACTOR = 252;

// ---------- indicator math ----------
function emaSeries(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
        if (values[i] == null) continue;
        prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}
function rsiSeries(closes, period) {
    const out = new Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = Math.max(change, 0), loss = Math.max(-change, 0);
        if (i <= period) {
            avgGain += gain / period; avgLoss += loss / period;
            if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        } else {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
    }
    return out;
}
function donchian(bars, n, idx) {
    if (idx < n) return null;
    let hi = -Infinity, lo = Infinity;
    for (let i = idx - n; i < idx; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
    return { hi, lo };
}

// ---------- generic trade engine: given per-bar signal direction (+1/-1/0), run entry + exits ----------
function runDetector(bars, signals, confirmFn, confirmKey, confirmLabel) {
    const exitKeys = [...DAILY_EXITS.map(d => d.key), STOP_DEF.key, confirmKey];
    const pooled = { follow: {}, fade: {} };
    for (const hyp of ['follow', 'fade']) for (const k of exitKeys) pooled[hyp][k] = [];

    for (let t = 0; t < bars.length - 1; t++) {
        if (!signals[t]) continue;
        const followDir = signals[t]; // +1 long, -1 short (textbook direction)
        const fadeDir = -followDir;
        const entryIdx = t + 1;
        const entryPrice = bars[entryIdx].open;
        const entryKey = bars[entryIdx].date;

        for (const def of DAILY_EXITS) {
            const exitIdx = Math.min(entryIdx + def.holdBars - 1, bars.length - 1);
            const rawRet = ((bars[exitIdx].close - entryPrice) / entryPrice) * 100;
            pooled.follow[def.key].push({ retPct: followDir * rawRet, entryKey });
            pooled.fade[def.key].push({ retPct: fadeDir * rawRet, entryKey });
        }
        const followStop = applyMultiDayStop(bars, entryIdx, followDir, STOP_DEF.holdBars, STOP_DEF.stopPct);
        const fadeStop = applyMultiDayStop(bars, entryIdx, fadeDir, STOP_DEF.holdBars, STOP_DEF.stopPct);
        pooled.follow[STOP_DEF.key].push({ retPct: followStop.retPct, entryKey, stopped: followStop.stopped });
        pooled.fade[STOP_DEF.key].push({ retPct: fadeStop.retPct, entryKey, stopped: fadeStop.stopped });

        // confirmation-based exit (method-specific signal flip), confirmed bar's NEXT open, never its own price
        for (const [hyp, dir] of [['follow', followDir], ['fade', fadeDir]]) {
            let flipIdx = -1;
            for (let k = entryIdx + 1; k < Math.min(entryIdx + CAP_BARS, bars.length); k++) {
                if (confirmFn(k, dir)) { flipIdx = k; break; }
            }
            const exitIdx = flipIdx === -1 ? Math.min(entryIdx + CAP_BARS - 1, bars.length - 1) : Math.min(flipIdx + 1, bars.length - 1);
            const rawRet = ((bars[exitIdx].close - entryPrice) / entryPrice) * 100; // horizon/time-cap fallback uses close; confirmed flips use next-open via exitIdx shift
            const retPct = flipIdx === -1 ? dir * rawRet : dir * ((bars[exitIdx].open - entryPrice) / entryPrice) * 100;
            pooled[hyp][confirmKey].push({ retPct, entryKey, unresolved: flipIdx === -1 });
        }
    }

    const summarizeKeys = (trades) => {
        const out = {};
        for (const key of exitKeys) {
            const tr = trades[key] || [];
            const stopRate = tr.length && tr.some(t => t.stopped !== undefined) ? +((tr.filter(t => t.stopped).length / tr.length) * 100).toFixed(2) : undefined;
            const unresolvedRate = tr.length && tr.some(t => t.unresolved !== undefined) ? +((tr.filter(t => t.unresolved).length / tr.length) * 100).toFixed(2) : undefined;
            const { older, newer } = splitHalves(tr);
            out[key] = { ...summarize(tr, ANN_FACTOR), olderHalf: summarize(older, ANN_FACTOR), newerHalf: summarize(newer, ANN_FACTOR) };
            if (stopRate !== undefined) out[key].stopRate = stopRate;
            if (unresolvedRate !== undefined) out[key].unresolvedRate = unresolvedRate;
        }
        return out;
    };
    return { pooled, exitKeys, hypSummaries: { follow: summarizeKeys(pooled.follow), fade: summarizeKeys(pooled.fade) } };
}

function aggregate(symbolResults, exitKeys) {
    const pooledAll = { follow: {}, fade: {} };
    for (const hyp of ['follow', 'fade']) for (const k of exitKeys) pooledAll[hyp][k] = [];
    let totalSignals = 0, usedSymbols = 0;
    const perSymbol = {};
    for (const [sym, r] of Object.entries(symbolResults)) {
        if (!r) continue;
        usedSymbols++;
        for (const hyp of ['follow', 'fade']) for (const k of exitKeys) pooledAll[hyp][k].push(...r.pooled[hyp][k]);
        perSymbol[sym] = r.pooled;
        totalSignals += r.pooled.follow[exitKeys[0]].length;
    }
    const summarizeKeys = (trades) => {
        const out = {};
        for (const key of exitKeys) {
            const tr = trades[key] || [];
            const stopRate = tr.length && tr.some(t => t.stopped !== undefined) ? +((tr.filter(t => t.stopped).length / tr.length) * 100).toFixed(2) : undefined;
            const unresolvedRate = tr.length && tr.some(t => t.unresolved !== undefined) ? +((tr.filter(t => t.unresolved).length / tr.length) * 100).toFixed(2) : undefined;
            const { older, newer } = splitHalves(tr);
            out[key] = { ...summarize(tr, ANN_FACTOR), olderHalf: summarize(older, ANN_FACTOR), newerHalf: summarize(newer, ANN_FACTOR) };
            if (stopRate !== undefined) out[key].stopRate = stopRate;
            if (unresolvedRate !== undefined) out[key].unresolvedRate = unresolvedRate;
        }
        return out;
    };
    const hypSummaries = { follow: summarizeKeys(pooledAll.follow), fade: summarizeKeys(pooledAll.fade) };
    const followBest = bestOf(hypSummaries.follow);
    const fadeBest = bestOf(hypSummaries.fade);
    const winnerHyp = (fadeBest && (!followBest || fadeBest.sharpeLike > followBest.sharpeLike)) ? 'fade' : 'follow';
    const winnerBest = winnerHyp === 'fade' ? fadeBest : followBest;

    const leaderboard = [];
    for (const [sym, pooled] of Object.entries(perSymbol)) {
        const tr = pooled[winnerHyp][winnerBest.key] || [];
        if (tr.length < 8) continue;
        const { older, newer } = splitHalves(tr);
        const s = { ...summarize(tr, ANN_FACTOR), olderHalf: summarize(older, ANN_FACTOR), newerHalf: summarize(newer, ANN_FACTOR) };
        leaderboard.push({ symbol: sym, ...s, robust: isRobust(s) });
    }
    leaderboard.sort((a, b) => b.sharpeLike - a.sharpeLike);

    return { usedSymbols, totalSignals, exitKeys, hypSummaries, winnerHyp, winnerBest,
        leaderboard: leaderboard.slice(0, 10).concat(leaderboard.length > 10 ? leaderboard.slice(-5) : []),
        leaderboardFullCount: leaderboard.length };
}

// ---------- method 1: Donchian Channel Breakout (the "breakout"/"Donchian" the user asked for) ----------
function donchianMethod(bars, entryN, exitN) {
    const signals = new Array(bars.length).fill(0);
    for (let t = entryN; t < bars.length; t++) {
        const ch = donchian(bars, entryN, t);
        if (!ch) continue;
        if (bars[t].close > ch.hi) signals[t] = 1;
        else if (bars[t].close < ch.lo) signals[t] = -1;
    }
    const confirmFn = (k, dir) => {
        const ch = donchian(bars, exitN, k);
        if (!ch) return false;
        return dir === 1 ? bars[k].close < ch.lo : bars[k].close > ch.hi;
    };
    return runDetector(bars, signals, confirmFn, 'exit_channel_' + exitN + 'd', 'Exit-Kanal ' + exitN + 'T');
}

// ---------- method 2: RSI(14) oversold/overbought ----------
function rsiMethod(bars) {
    const closes = bars.map(b => b.close);
    const rsi = rsiSeries(closes, 14);
    const signals = new Array(bars.length).fill(0);
    for (let t = 15; t < bars.length; t++) {
        if (rsi[t] == null) continue;
        if (rsi[t] < 30) signals[t] = 1;   // textbook: oversold -> buy
        else if (rsi[t] > 70) signals[t] = -1; // textbook: overbought -> sell
    }
    const confirmFn = (k, dir) => rsi[k] != null && (dir === 1 ? rsi[k] >= 50 : rsi[k] <= 50);
    return runDetector(bars, signals, confirmFn, 'rsi_cross_50', 'RSI kreuzt 50');
}

// ---------- method 3: MACD(12,26,9) crossover ----------
function macdMethod(bars) {
    const closes = bars.map(b => b.close);
    const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
    const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
    const signalLine = emaSeries(macdLine, 9);
    const hist = closes.map((_, i) => (macdLine[i] != null && signalLine[i] != null) ? macdLine[i] - signalLine[i] : null);
    const signals = new Array(bars.length).fill(0);
    for (let t = 35; t < bars.length; t++) {
        if (hist[t] == null || hist[t - 1] == null) continue;
        if (hist[t - 1] <= 0 && hist[t] > 0) signals[t] = 1;
        else if (hist[t - 1] >= 0 && hist[t] < 0) signals[t] = -1;
    }
    const confirmFn = (k, dir) => {
        if (hist[k] == null || hist[k - 1] == null) return false;
        return dir === 1 ? (hist[k - 1] >= 0 && hist[k] < 0) : (hist[k - 1] <= 0 && hist[k] > 0);
    };
    return runDetector(bars, signals, confirmFn, 'macd_opp_cross', 'Gegen-Crossover');
}

// ---------- control: random entries at the SAME frequency/direction-mix as Donchian20 ----------
// Critical honesty check: stop4pct_10d has now won "best exit rule" for every single different
// entry signal tested across this entire repo (NOVEM's 9 signals, Heikin-Narrow, and all three
// methods above). That raises a real question -- is the -4%-stop/10-day-hold structure itself
// doing most of the work (stocks drift up on average, losses capped, winners uncapped) regardless
// of what triggers the entry? A seeded-random entry control, same trigger rate as Donchian20,
// answers that directly instead of leaving it as a suspicion.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomMethod(bars, triggerProb, rng) {
    const signals = new Array(bars.length).fill(0);
    for (let t = 20; t < bars.length - 1; t++) {
        if (rng() < triggerProb) signals[t] = rng() < 0.5 ? 1 : -1;
    }
    // no method-specific confirm exit for a random trigger -- reuse the RSI-50-cross confirm
    // function shape but tie it to nothing meaningful; only horizon/stop exits are reported.
    const confirmFn = () => false;
    return runDetector(bars, signals, confirmFn, 'na', 'n/a');
}

// ---------- run everything ----------
const output = { meta: { generatedAt: new Date().toISOString(), universe: Object.keys(dailyRaw).length }, methods: {} };

for (const [label, entryN, exitN] of [['donchian20', 20, 10], ['donchian55', 55, 20]]) {
    const perSym = {};
    for (const [sym, bars] of Object.entries(dailyRaw)) { if (bars.length > entryN + 30) perSym[sym] = donchianMethod(bars, entryN, exitN); }
    output.methods[label] = aggregate(perSym, [...DAILY_EXITS.map(d => d.key), STOP_DEF.key, 'exit_channel_' + exitN + 'd']);
}
{
    const perSym = {};
    for (const [sym, bars] of Object.entries(dailyRaw)) { if (bars.length > 60) perSym[sym] = rsiMethod(bars); }
    output.methods.rsi14 = aggregate(perSym, [...DAILY_EXITS.map(d => d.key), STOP_DEF.key, 'rsi_cross_50']);
}
{
    const perSym = {};
    for (const [sym, bars] of Object.entries(dailyRaw)) { if (bars.length > 60) perSym[sym] = macdMethod(bars); }
    output.methods.macd = aggregate(perSym, [...DAILY_EXITS.map(d => d.key), STOP_DEF.key, 'macd_opp_cross']);
}

// random-entry control, same trigger frequency as donchian20, 5 seeds for a distribution not a
// single lucky/unlucky draw
{
    const totalBarDays = Object.values(dailyRaw).reduce((s, b) => s + b.length, 0);
    const triggerProb = output.methods.donchian20.totalSignals / totalBarDays;
    const runs = [];
    for (let seed = 1; seed <= 5; seed++) {
        const rng = mulberry32(seed * 7919);
        const perSym = {};
        for (const [sym, bars] of Object.entries(dailyRaw)) { if (bars.length > 60) perSym[sym] = randomMethod(bars, triggerProb, rng); }
        const agg = aggregate(perSym, [...DAILY_EXITS.map(d => d.key), STOP_DEF.key, 'na']);
        const stopStat = agg.hypSummaries.follow[STOP_DEF.key]; // direction is already random per-trade, "follow"==the only pool
        runs.push({ seed, n: stopStat.n, sharpeLike: stopStat.sharpeLike, avgRet: stopStat.avgRet, winRate: stopStat.winRate, robust: isRobust(stopStat) });
    }
    output.randomControl = { triggerProb: +triggerProb.toFixed(4), runs };
}

fs.writeFileSync(OUT, JSON.stringify(output));
console.log('Saved to', OUT);
for (const [key, m] of Object.entries(output.methods)) {
    const w = m.winnerBest;
    console.log(key, '| symbols:', m.usedSymbols, '| signals:', m.totalSignals, '| winner:', m.winnerHyp, w.key, '| sharpe:', w.sharpeLike, '| winRate:', w.winRate, '| n:', w.n, '| robust?', isRobust(w));
}
console.log('\nRANDOM CONTROL (stop4pct_10d, triggerProb=' + output.randomControl.triggerProb + '):');
output.randomControl.runs.forEach(r => console.log('  seed', r.seed, '| n:', r.n, '| sharpe:', r.sharpeLike, '| avgRet:', r.avgRet, '| winRate:', r.winRate, '| robust?', r.robust));
