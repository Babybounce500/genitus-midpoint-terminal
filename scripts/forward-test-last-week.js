// scripts/forward-test-last-week.js
//
// Out-of-sample spot check: compares what the two LIVE tools (Heikin-Narrow Daily tab,
// Intraday-Markov Hourly setup card) would have signaled using ONLY the data available a
// week ago, against what ACTUALLY happened since, using freshly fetched live data.
//
// This is NOT a new backtest and proves nothing statistically (a handful of real trades over
// one week is not a sample size) -- it's a sanity check that the live logic still behaves the
// way the backtest said it should, using real forward data instead of replayed history.
//
// OLD snapshots (what the tools would have shown a week ago):
//   data/.cache/novem-ohlc-cache.OLD-2026-11-06.json   (daily, cutoff close 2026-11-06)
//   data/.cache/markov-hourly-cache.OLD-2026-11-10.json (hourly, cutoff bar 2026-11-10 20:30 UTC)
// NEW live data (refetched today, same 52-symbol universe, same proxies):
//   data/.cache/novem-ohlc-cache.json
//   data/.cache/markov-hourly-cache.json

const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, '..', 'data', '.cache');

const dailyOld = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'novem-ohlc-cache.OLD-2026-11-06.json'), 'utf8'));
const dailyNew = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'novem-ohlc-cache.json'), 'utf8'));
const hourlyOld = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'markov-hourly-cache.OLD-2026-11-10.json'), 'utf8'));
const hourlyNew = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'markov-hourly-cache.json'), 'utf8'));

function heikinAshi(bars) {
    const ha = [];
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const haClose = (b.open + b.high + b.low + b.close) / 4;
        const haOpen  = i === 0 ? (b.open + b.close) / 2 : (ha[i-1].haOpen + ha[i-1].haClose) / 2;
        const haHigh  = Math.max(b.high, haOpen, haClose);
        const haLow   = Math.min(b.low, haOpen, haClose);
        ha.push({ haOpen, haHigh, haLow, haClose, range: haHigh - haLow, dir: haClose >= haOpen ? 'G' : 'R' });
    }
    return ha;
}
function isNarrow(ha, idx, nrN) {
    if (idx < nrN - 1) return false;
    const win = ha.slice(idx - nrN + 1, idx + 1);
    return ha[idx].range === Math.min(...win.map(b => b.range));
}
function isWide(ha, idx, nrN) {
    if (idx < nrN - 1) return false;
    const win = ha.slice(idx - nrN + 1, idx + 1);
    return ha[idx].range === Math.max(...win.map(b => b.range));
}

/* ═══════════════════════ DAILY HEIKIN-NARROW (continuation, NR4 + NR7) ═══════════════════════ */
console.log('='.repeat(70));
console.log('DAILY HEIKIN-NARROW -- forward test, signal date 2026-11-06, live through', Object.values(dailyNew)[0].slice(-1)[0].date);
console.log('='.repeat(70));

const dailyResults = { 4: [], 7: [] };
for (const nrN of [4, 7]) {
    for (const [sym, oldBars] of Object.entries(dailyOld)) {
        if (oldBars.length < nrN + 5) continue;
        const haOld = heikinAshi(oldBars);
        const lastOldIdx = haOld.length - 1;
        if (!isNarrow(haOld, lastOldIdx, nrN)) continue; // no signal a week ago
        const isLong = haOld[lastOldIdx].dir === 'G'; // continuation
        const signalDate = oldBars[lastOldIdx].date;

        const newBars = dailyNew[sym];
        const entryIdx = newBars.findIndex(b => b.date > signalDate);
        if (entryIdx === -1) continue;
        const entryPrice = newBars[entryIdx].open;
        const stopPrice = isLong ? entryPrice * 0.96 : entryPrice * 1.04;

        let stopped = false, stopDate = null;
        const horizonEnd = Math.min(entryIdx + 9, newBars.length - 1); // 10-day window
        for (let i = entryIdx; i <= horizonEnd; i++) {
            if (isLong && newBars[i].low <= stopPrice) { stopped = true; stopDate = newBars[i].date; break; }
            if (!isLong && newBars[i].high >= stopPrice) { stopped = true; stopDate = newBars[i].date; break; }
        }
        const lastAvailIdx = Math.min(horizonEnd, newBars.length - 1);
        const curPrice = stopped ? stopPrice : newBars[lastAvailIdx].close;
        const retPct = (isLong ? 1 : -1) * ((curPrice - entryPrice) / entryPrice) * 100;
        const daysElapsed = lastAvailIdx - entryIdx + 1;
        const complete = stopped || (entryIdx + 9 <= newBars.length - 1);

        dailyResults[nrN].push({ sym, isLong, signalDate, entryPrice: +entryPrice.toFixed(2), stopped, stopDate,
            curPrice: +curPrice.toFixed(2), retPct: +retPct.toFixed(2), daysElapsed, complete });
    }
}

for (const nrN of [4, 7]) {
    const rows = dailyResults[nrN];
    console.log(`\n--- NR${nrN}: ${rows.length} Signale vom 2026-11-06 ---`);
    rows.sort((a,b) => b.retPct - a.retPct);
    rows.forEach(r => console.log(
        `${r.sym.padEnd(8)} ${r.isLong ? 'LONG ' : 'SHORT'} entry=${r.entryPrice} now=${r.curPrice} ` +
        `ret=${r.retPct >= 0 ? '+' : ''}${r.retPct}% ${r.stopped ? '[STOPPED @ ' + r.stopDate + ']' : ''} (${r.daysElapsed}/10 Tage, ${r.complete ? 'fertig' : 'läuft noch'})`
    ));
    if (rows.length) {
        const avgRet = rows.reduce((s,r) => s + r.retPct, 0) / rows.length;
        const wins = rows.filter(r => r.retPct > 0).length;
        const stops = rows.filter(r => r.stopped).length;
        console.log(`SUMMARY NR${nrN}: n=${rows.length} | avgRet=${avgRet.toFixed(2)}% | winRate=${(wins/rows.length*100).toFixed(1)}% | stopped=${stops}/${rows.length}`);
    }
}

/* ═══════════════════════ HOURLY INTRADAY-MARKOV (reversal, NR4) ═══════════════════════ */
console.log('\n' + '='.repeat(70));
console.log('HOURLY INTRADAY-MARKOV (NR4, Umkehr) -- forward test, cutoff 2026-11-10 20:30 UTC');
console.log('='.repeat(70));

const CUTOFF_T = new Date('2026-11-10T20:30:00Z').getTime() / 1000;
const hourlyResults = [];
for (const [sym, oldBars] of Object.entries(hourlyOld)) {
    if (oldBars.length < 10) continue;
    const haOld = heikinAshi(oldBars);
    const lastOldIdx = haOld.length - 1;
    if (!isNarrow(haOld, lastOldIdx, 4)) continue; // no signal a week ago
    const isShort = haOld[lastOldIdx].dir === 'G'; // reversal
    const dir = isShort ? -1 : 1;

    const newBars = hourlyNew[sym];
    const entryIdx = newBars.findIndex(b => b.t > CUTOFF_T);
    if (entryIdx === -1 || entryIdx + 1 >= newBars.length) continue;
    const entryPrice = newBars[entryIdx].open;

    // rebuild HA across the full new series so bar-level NR/WR checks are consistent with the live tool
    const haNew = heikinAshi(newBars);
    const wantColor = isShort ? 'R' : 'G';
    let exitIdx = -1, resolved = false;
    const capEnd = Math.min(entryIdx + 20, newBars.length - 1);
    for (let k = entryIdx + 1; k <= capEnd; k++) {
        if (isWide(haNew, k, 4) && haNew[k].dir === wantColor) { exitIdx = Math.min(k + 1, newBars.length - 1); resolved = true; break; }
    }
    if (!resolved) exitIdx = capEnd; // unresolved -- mark-to-market at the cap/most-recent available bar
    const exitPrice = newBars[exitIdx].open;
    const retPct = dir * ((exitPrice - entryPrice) / entryPrice) * 100;

    hourlyResults.push({ sym, isShort, entryPrice: +entryPrice.toFixed(2), exitPrice: +exitPrice.toFixed(2),
        retPct: +retPct.toFixed(3), resolved, barsHeld: exitIdx - entryIdx });
}

hourlyResults.sort((a,b) => b.retPct - a.retPct);
hourlyResults.forEach(r => console.log(
    `${r.sym.padEnd(8)} ${r.isShort ? 'SHORT' : 'LONG '} entry=${r.entryPrice} exit=${r.exitPrice} ` +
    `ret=${r.retPct >= 0 ? '+' : ''}${r.retPct}% (${r.barsHeld} Bars, ${r.resolved ? 'bestätigt' : 'unresolved/mark-to-market'})`
));
if (hourlyResults.length) {
    const avgRet = hourlyResults.reduce((s,r) => s + r.retPct, 0) / hourlyResults.length;
    const wins = hourlyResults.filter(r => r.retPct > 0).length;
    const resolvedN = hourlyResults.filter(r => r.resolved).length;
    console.log(`SUMMARY: n=${hourlyResults.length} | avgRet=${avgRet.toFixed(3)}% | winRate=${(wins/hourlyResults.length*100).toFixed(1)}% | resolved=${resolvedN}/${hourlyResults.length}`);
}

fs.writeFileSync(path.join(__dirname, '..', 'data', 'forward-test-last-week-result.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), daily: dailyResults, hourly: hourlyResults
}, null, 2));
console.log('\nSaved to data/forward-test-last-week-result.json');
