// scripts/novem-fetch-cache.js
// Fetches 3 years of daily OHLCV (incl. volume) for the NOVEM-Suite backtest universe
// (same 52-symbol union of S&P500/Nasdaq100 samples used by the pivot-daily backtest).
// Source: theserver-open-ai.replit.app (the project's established proxy), NOT the unofficial
// gemini-os.replit.app endpoint the original prototypes used.

const fs = require('fs');
const path = require('path');

const PROXY = 'https://theserver-open-ai.replit.app';
const OUT_DIR = path.join(__dirname, '..', 'data', '.cache');
const OUT = path.join(OUT_DIR, 'novem-ohlc-cache.json');

const SYMBOLS = [
  'MSFT.US', 'GOOGL.US', 'META.US', 'AVGO.US', 'ORCL.US', 'CRM.US', 'ADBE.US', 'UNH.US', 'LLY.US', 'ABBV.US',
  'TMO.US', 'ABT.US', 'JPM.US', 'BAC.US', 'WFC.US', 'GS.US', 'MA.US', 'V.US', 'HD.US', 'MCD.US',
  'NKE.US', 'SBUX.US', 'CAT.US', 'HON.US', 'UPS.US', 'BA.US', 'XOM.US', 'CVX.US', 'NFLX.US', 'DIS.US',
  'AAPL.US', 'NVDA.US', 'AMZN.US', 'TSLA.US', 'COST.US', 'AMD.US', 'PEP.US', 'CSCO.US', 'TMUS.US', 'INTC.US',
  'CMCSA.US', 'QCOM.US', 'TXN.US', 'AMGN.US', 'INTU.US', 'AMAT.US', 'BKNG.US', 'GILD.US', 'ADI.US', 'MDLZ.US',
  'ISRG.US', 'MU.US'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDaily(symbol) {
  const from = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const res = await fetch(PROXY + '/eod/historical/' + encodeURIComponent(symbol) + '?from=' + from);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('bad response');
  // Split-adjust O/H/L using the ratio adjusted_close/close (the proxy only gives an adjusted close,
  // not adjusted O/H/L) -- without this, any symbol with a stock split inside the 3y window produces
  // a one-day price discontinuity that corrupts every detector reading across that split date.
  return raw
    .filter(h => h && h.date && [h.open, h.high, h.low, h.close, h.volume].every(v => Number.isFinite(Number(v))) && Number.isFinite(Number(h.adjusted_close)) && Number(h.close) > 0)
    .map(h => {
      const adjFactor = Number(h.adjusted_close) / Number(h.close);
      return {
        date: h.date,
        open: +h.open * adjFactor,
        high: +h.high * adjFactor,
        low: +h.low * adjFactor,
        close: +h.adjusted_close,
        volume: +h.volume
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cache = {};
  let ok = 0, failed = [];
  for (const sym of SYMBOLS) {
    try {
      const bars = await fetchDaily(sym);
      if (bars.length < 100) { failed.push(sym + ' (too few bars: ' + bars.length + ')'); continue; }
      cache[sym] = bars;
      ok++;
      console.log(sym, bars.length, 'bars OK');
    } catch (e) {
      failed.push(sym + ' (' + e.message + ')');
      console.log(sym, 'FAILED:', e.message);
    }
    await sleep(100);
  }
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log('---');
  console.log('OK:', ok, '/', SYMBOLS.length);
  console.log('Failed:', failed.join(', ') || 'none');
  console.log('Saved to', OUT);
})();
