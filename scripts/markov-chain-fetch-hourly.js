// scripts/markov-chain-fetch-hourly.js
// Fetches hourly (1h) OHLC for the Markov-Chain backtest's Hourly tier, same 52-symbol
// universe as the NOVEM-Suite daily cache. Source: open-bb.replit.app (Yahoo-Finance
// passthrough) -- the regular EOD proxies' /eod/intraday endpoint is confirmed dead
// (theserver-open-ai.replit.app 500s, gemini-os.replit.app 403s on every symbol+interval
// combo tested), same finding already documented for the live Intraday-Markov tab in
// KOMMANDOZENTRALE-V2.html. The proxy also ignores the requested `range` and always
// returns its maximum available window (~1 trading year) -- treated as a feature here
// (bigger sample), not a bug to fight.

const fs = require('fs');
const path = require('path');

const PROXY = 'https://open-bb.replit.app/api';
const OUT_DIR = path.join(__dirname, '..', 'data', '.cache');
const OUT = path.join(OUT_DIR, 'markov-hourly-cache.json');
const NOVEM_CACHE = path.join(OUT_DIR, 'novem-ohlc-cache.json');

const SYMBOLS = Object.keys(JSON.parse(fs.readFileSync(NOVEM_CACHE, 'utf8')));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHourly(symbol) {
  const yahooTicker = symbol.replace(/\.US$/, '');
  const url = `${PROXY}/yahoo/chart/${yahooTicker}?range=1y&interval=1h&cb=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('no result');
  const quotes = result.indicators.quote[0];
  const timestamps = result.timestamp;
  if (!timestamps) throw new Error('no timestamps');
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quotes.open[i], h = quotes.high[i], l = quotes.low[i], c = quotes.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ t: timestamps[i], open: o, high: h, low: l, close: c });
  }
  return bars;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cache = {};
  let ok = 0, failed = [];
  for (const sym of SYMBOLS) {
    try {
      const bars = await fetchHourly(sym);
      if (bars.length < 200) { failed.push(sym + ' (too few bars: ' + bars.length + ')'); continue; }
      cache[sym] = bars;
      ok++;
      console.log(sym, bars.length, 'hourly bars OK');
    } catch (e) {
      failed.push(sym + ' (' + e.message + ')');
      console.log(sym, 'FAILED:', e.message);
    }
    await sleep(150);
  }
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log('---');
  console.log('OK:', ok, '/', SYMBOLS.length);
  console.log('Failed:', failed.join(', ') || 'none');
  console.log('Saved to', OUT);
})();
