// scripts/generate-smart-target-tools.js
// Generates the 10 "best edge" live tools (see data/smart-target-master-result.json ->
// masterRanking, robustness-filtered) -- each pairs one already-backtested signal's exact
// detection formula with the Smart Stop (validated flat -4%/10d) + Smart Target (bucket-aware
// avgRet) + live GBM vol-bucket badge, same methodology as broker-ai-trade-signals.html.
// Output: 10 standalone HTML files written directly to mcp-server/trading/.

const fs = require('fs');
const path = require('path');

const OUT_DIR = 'E:\\mcp-server\\trading';

const SHARED_HEAD = (title) => `<!DOCTYPE html>
<html lang="de" class="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <script>
    tailwind.config = { darkMode: 'class', theme: { extend: { colors: {
      primary: { DEFAULT: "hsl(221.2 83.2% 53.3%)", foreground: "hsl(210 40% 98%)" }
    } } } }
  </script>
  <style>
    .dark { --background: 222.2 84% 4.9%; --foreground: 210 40% 98%; }
    body { background-color: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%)); }
    @media(max-width:768px){ html,body{overflow-x:hidden;max-width:100%} input,select,button{font-size:16px!important} table{display:block;overflow-x:auto} }
  </style>
</head>
<body class="min-h-screen antialiased">`;

const SHARED_SCRIPT_HEAD = `
  window.API_BASE_URL = 'https://glow-up-gemini.replit.app';
  const BASE = window.API_BASE_URL;
  async function getJSON(path, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await fetch(BASE + path + qs);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  const API = { eod: { historical: (s, p) => getJSON('/eod/historical/' + s, p) } };
  function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

  function normCDF(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign = x<0?-1:1; const z=Math.abs(x)/Math.sqrt(2); const t=1/(1+p*z);
    const erf=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-z*z);
    return 0.5*(1+sign*erf);
  }
  function estimateSigmaMu(prices) {
    const lr=[]; for(let i=1;i<prices.length;i++) if(prices[i]>0&&prices[i-1]>0) lr.push(Math.log(prices[i]/prices[i-1]));
    if (lr.length<20) return null;
    const mean=lr.reduce((a,b)=>a+b,0)/lr.length;
    const variance=lr.reduce((a,b)=>a+Math.pow(b-mean,2),0)/(lr.length-1);
    const sigma=Math.sqrt(variance*252); const mu=mean*252+0.5*sigma*sigma;
    return { sigma, mu };
  }
  function probHitTarget(S,K,mu,sigma,T) {
    if (S===K) return 1.0; if (sigma<=0||T<=0) return 0.0;
    const v=mu-0.5*sigma*sigma, b=Math.abs(Math.log(K/S)), sst=sigma*Math.sqrt(T);
    const d1=(-b+v*T)/sst, d2=(-b-v*T)/sst;
    return Math.min(Math.max(normCDF(d1)+Math.exp((2*v*b)/(sigma*sigma))*normCDF(d2),0),1);
  }
  function volBucketOf(p){ return p<0.40?'far_lowP':p<0.70?'mid_P':'near_highP'; }
  const VOL_LABEL = { far_lowP:'🔴 Ruhiges Regime', mid_P:'🟡 Mittleres Regime', near_highP:'🟢 Volatiles Regime (Ziel-Bucket dieses Tools)' };
  const STOP_PCT = 4, HOLD_DAYS = 10, T_YEARS = HOLD_DAYS/252;

  async function getVolRegime(symbol, price, direction) {
    try {
      const hist = await API.eod.historical(symbol, { from: isoDaysAgo(400) });
      const closes = (Array.isArray(hist)?hist:[]).map(h=>h.close).filter(c=>c>0);
      if (closes.length < 20) return null;
      const params = estimateSigmaMu(closes);
      if (!params) return null;
      const stopLevel = direction==='LONG' ? price*(1-STOP_PCT/100) : price*(1+STOP_PCT/100);
      const pTouchStop = probHitTarget(price, stopLevel, params.mu, params.sigma, T_YEARS);
      return { pTouchStop, sigma: params.sigma, bucket: volBucketOf(pTouchStop) };
    } catch (e) { console.error('getVolRegime failed', e); return null; }
  }
  // Echtes Limit statt Erwartungswert: Target = Entry +/- Ø-Groesse der tatsaechlichen GEWINNER-Trades
  // in diesem Bucket (winBuckets), nicht der Durchschnitt ueber ALLE Trades (der war nur 0.17-0.69%
  // gross und erzeugte ein absurdes 1:20-Chance/Risiko gegen den festen 4%-Stop). Stop bleibt hart -4%.
  function smartStopTarget(price, direction, bucket) {
    const sign = direction==='LONG'?1:-1;
    const bucketAvgRet = BACKTEST.buckets[bucket] != null ? BACKTEST.buckets[bucket] : null;
    const noEdge = bucketAvgRet == null || bucketAvgRet < 0;
    const winPct = (BACKTEST.winBuckets && BACKTEST.winBuckets[bucket] != null) ? BACKTEST.winBuckets[bucket] : STOP_PCT;
    const hitRate = (BACKTEST.winRateBuckets && BACKTEST.winRateBuckets[bucket] != null) ? BACKTEST.winRateBuckets[bucket] : BACKTEST.winRate;
    const target = price*(1+sign*(winPct/100));
    const stop = price*(1-sign*(STOP_PCT/100));
    return { target: target.toFixed(2), stop: stop.toFixed(2), winPct, hitRate, bucketAvgRet, noEdge };
  }
`;

const RESULT_CARD = `
function renderCard(sym, price, direction, vts, volRegime) {
  const container = document.getElementById('results');
  const noEdge = vts.noEdge;
  const card = document.createElement('div');
  card.className = 'bg-white dark:bg-gray-900 rounded-lg shadow p-4 mb-3';
  card.innerHTML = \`
    <div class="flex justify-between items-center mb-2">
      <h3 class="font-bold text-lg">\${sym}</h3>
      <span class="px-2 py-1 rounded text-xs font-bold \${direction==='LONG' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'}">\${direction}</span>
    </div>
    \${noEdge ? '<div class="bg-red-100 dark:bg-red-900/40 border border-red-400 text-red-800 dark:text-red-300 text-xs font-bold p-2 rounded text-center mb-2">⛔ KEIN TRADE EMPFOHLEN -- ausserhalb des validierten Vola-Buckets</div>' : ''}
    <div class="font-mono text-sm space-y-1.5">
      <div class="flex justify-between bg-gray-100 dark:bg-gray-800 p-1.5 rounded"><span>ENTRY</span><span class="font-bold">\${price.toFixed(2)}</span></div>
      <div class="flex justify-between \${noEdge?'bg-gray-100 dark:bg-gray-800 opacity-60':'bg-blue-50 dark:bg-blue-950'} p-1.5 rounded"><span>SMART TARGET (Limit)</span><span class="font-bold \${noEdge?'text-gray-500':'text-blue-600 dark:text-blue-400'}">\${vts.target}</span></div>
      <div class="flex justify-between bg-orange-50 dark:bg-orange-950 p-1.5 rounded"><span>SMART STOP (-4%, hart)</span><span class="font-bold text-orange-600 dark:text-orange-400">\${vts.stop}</span></div>
    </div>
    <div class="text-[10px] text-gray-400 dark:text-gray-500 mt-1 px-1">🎯 Echtes Limit: Ø-Größe der tatsächlichen <b>Gewinner</b>-Trades in diesem Bucket (±\${vts.winPct.toFixed(2)}%), nicht der Durchschnitt über alle Trades. Trifft ca. in \${vts.hitRate}% der Fälle (sonst meist Stop). R:R ≈ \${(vts.winPct/STOP_PCT).toFixed(1)}:1 gegen den festen \${STOP_PCT}%-Stop, max. \${HOLD_DAYS} Handelstage Haltedauer.</div>
    \${volRegime ? \`
    <div class="text-[11px] text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
      <div>🎯 P(Touch Stop in \${HOLD_DAYS}d) = \${(volRegime.pTouchStop*100).toFixed(0)}% (σ=\${(volRegime.sigma*100).toFixed(1)}%)</div>
      <div class="mt-0.5">\${VOL_LABEL[volRegime.bucket]}</div>
    </div>\` : ''}
    <div class="text-[11px] text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
      📊 Backtest (Ziel-Bucket \${BACKTEST.bestBucket}): n=\${BACKTEST.n.toLocaleString('de-DE')} · WinRate \${BACKTEST.winRate}% · Ø\${BACKTEST.avgRet}% · Sharpe \${BACKTEST.sharpeLike} \${BACKTEST.robust ? '✅ robust' : '⚠️ bedingt robust'}
    </div>
  \`;
  container.prepend(card);
}
`;

// ---------- 10 TOOL SPECS ----------
const TOOLS = [

{
  file: 'SMART-MONTHLY-EDGE.html', title: 'Smart Monthly Edge', icon: 'fa-calendar-days',
  heading: 'SMART MONTHLY EDGE', sub: 'Monats-Momentum (Broker-AI "Monthly") · bester Edge im volatilen Regime',
  backtest: { n: 5018, avgRet: 0.6901, winRate: 34.91, sharpeLike: 1.389, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: -0.2037, mid_P: 0.1676, near_highP: 0.6901 },
    winBuckets: { far_lowP: 3.3155, mid_P: 4.9328, near_highP: 9.0082 },
    winRateBuckets: { far_lowP: 44.85, mid_P: 42.83, near_highP: 34.91 } },
  detectorBody: `
    const monthlyData = await API.eod.historical(symbol, { from: lastFridayPrevMonth(), to: lastFridayPrevMonth() });
    monthlyData.sort((a,b)=>new Date(b.date)-new Date(a.date));
    const refClose = monthlyData.length ? monthlyData[0].close : null;
    if (!refClose) throw new Error('Keine Monatsdaten verfügbar');
    const cur = await API.eod.historical(symbol, { from: isoDaysAgo(10) });
    cur.sort((a,b)=>new Date(b.date)-new Date(a.date));
    const price = cur.length ? cur[0].close : null;
    if (!price) throw new Error('Keine aktuellen Daten verfügbar');
    const direction = price > refClose ? 'LONG' : 'SHORT';
    return { price, direction };
  `,
  extraHelpers: `
    function lastFridayPrevMonth() {
      const today = new Date();
      let m = today.getMonth(), y = (m===0)?today.getFullYear()-1:today.getFullYear();
      const prevMonth = (m===0)?11:m-1, prevYear = (m===0)?y:y;
      const last = new Date(prevYear, prevMonth+1, 0);
      while (last.getDay() !== 5) last.setDate(last.getDate()-1);
      return \`\${last.getFullYear()}-\${String(last.getMonth()+1).padStart(2,'0')}-\${String(last.getDate()).padStart(2,'0')}\`;
    }
  `,
  defaultWatchlist: 'AAPL.US, MSFT.US, NVDA.US, TSLA.US, SAP.XETRA, SIE.XETRA'
},

{
  file: 'SMART-DENARIUS-EDGE.html', title: 'Smart Denarius Edge', icon: 'fa-bolt',
  heading: 'SMART DENARIUS EDGE', sub: '2-Tage-Momentum-Spread (NOVEM "Denarius") · bester Edge im volatilen Regime',
  backtest: { n: 5057, avgRet: 0.4668, winRate: 34.19, sharpeLike: 0.995, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: null, mid_P: 0.209, near_highP: 0.4668 },
    winBuckets: { far_lowP: 3.3232, mid_P: 4.9775, near_highP: 8.6108 },
    winRateBuckets: { far_lowP: 45.41, mid_P: 43.1, near_highP: 34.19 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(14) });
    data.sort((a,b)=>new Date(b.date)-new Date(a.date));
    if (data.length < 3) throw new Error('Zu wenige Daten');
    const price = data[0].close;
    const spread = price / data[2].close;
    const direction = spread >= 1.0 ? 'LONG' : 'SHORT';
    return { price, direction };
  `,
  extraHelpers: '',
  defaultWatchlist: 'AMD.US, NVDA.US, TSLA.US, RHM.XETRA, BAYN.XETRA, ENR.XETRA'
},

{
  file: 'SMART-SPREAD-EDGE.html', title: 'Smart Spread Edge', icon: 'fa-chart-line',
  heading: 'SMART SPREAD EDGE', sub: '2-Tage-Momentum-Spread (Broker-AI "Spread") · bester Edge im volatilen Regime',
  backtest: { n: 5054, avgRet: 0.4653, winRate: 34.19, sharpeLike: 0.992, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: -0.1332, mid_P: 0.2087, near_highP: 0.4653 },
    winBuckets: { far_lowP: 3.3216, mid_P: 4.9752, near_highP: 8.6058 },
    winRateBuckets: { far_lowP: 45.42, mid_P: 43.11, near_highP: 34.19 } },
  note: 'Methodisch identisch mit Smart Denarius Edge (gleiche Formel, unabhängig aus zwei verschiedenen Quell-Dateien validiert) -- bewusst separat gelistet, Übereinstimmung ist Konsistenz-Check, kein Zufall.',
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(14) });
    data.sort((a,b)=>new Date(b.date)-new Date(a.date));
    if (data.length < 3) throw new Error('Zu wenige Daten');
    const price = data[0].close;
    const spread = price / data[2].close;
    const direction = spread > 1 ? 'LONG' : 'SHORT';
    return { price, direction };
  `,
  extraHelpers: '',
  defaultWatchlist: 'KO.US, PEP.US, JPM.US, DBK.XETRA, ALV.XETRA, VOW3.XETRA'
},

{
  file: 'SMART-MIDPOINT-EDGE.html', title: 'Smart Midpoint Edge', icon: 'fa-arrows-up-down',
  heading: 'SMART MIDPOINT EDGE', sub: 'Intraday-Mittelpunkt (Broker-AI "Midpoint") · bester Edge im volatilen Regime',
  backtest: { n: 5056, avgRet: 0.4395, winRate: 34.16, sharpeLike: 0.941, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: -0.0443, mid_P: 0.1821, near_highP: 0.4395 },
    winBuckets: { far_lowP: 3.3611, mid_P: 4.9094, near_highP: 8.5697 },
    winRateBuckets: { far_lowP: 46.48, mid_P: 43.26, near_highP: 34.16 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(5) });
    data.sort((a,b)=>new Date(b.date)-new Date(a.date));
    if (!data.length) throw new Error('Keine Daten');
    const d0 = data[0];
    const avgPrice = (d0.high + d0.low) / 2;
    const price = d0.close;
    if (price === avgPrice) throw new Error('Neutral -- kein Signal (Close == Mittelpunkt)');
    const direction = price > avgPrice ? 'LONG' : 'SHORT';
    return { price, direction };
  `,
  extraHelpers: '',
  defaultWatchlist: 'TSLA.US, NVDA.US, AMD.US, SIE.XETRA, IFX.XETRA, BMW.XETRA'
},

{
  file: 'SMART-WEEKLYSMA-EDGE.html', title: 'Smart WeeklySMA Edge', icon: 'fa-wave-square',
  heading: 'SMART WEEKLYSMA EDGE', sub: '3er-SMA-Crossover (Broker-AI "WeeklySMA") · bester Edge im volatilen Regime',
  backtest: { n: 5041, avgRet: 0.3741, winRate: 33.13, sharpeLike: 0.794, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: -0.2102, mid_P: 0.2251, near_highP: 0.3741 },
    winBuckets: { far_lowP: 3.3123, mid_P: 4.9551, near_highP: 8.7193 },
    winRateBuckets: { far_lowP: 44.6, mid_P: 43.42, near_highP: 33.13 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(12) });
    data.sort((a,b)=>new Date(b.date)-new Date(a.date));
    if (data.length < 5) throw new Error('Zu wenige Daten');
    const sma1 = (data[0].close + data[1].close + data[2].close) / 3;
    const sma3 = (data[2].close + data[3].close + data[4].close) / 3;
    const price = data[0].close;
    const direction = (sma1/sma3) > 1 ? 'LONG' : 'SHORT';
    return { price, direction };
  `,
  extraHelpers: '',
  defaultWatchlist: 'AAPL.US, GOOGL.US, META.US, SAP.XETRA, ADS.XETRA, MBG.XETRA'
},

{
  file: 'SMART-CONSULTUS-EDGE.html', title: 'Smart Consultus Edge', icon: 'fa-compress',
  heading: 'SMART CONSULTUS EDGE', sub: 'Kompressions-Breakout, täglich (NOVEM "Consultus Daily") · bester Edge im volatilen Regime',
  backtest: { n: 2532, avgRet: 0.3458, winRate: 32.58, sharpeLike: 0.739, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: null, mid_P: 0.245, near_highP: 0.3458 },
    winBuckets: { far_lowP: 3.2176, mid_P: 4.9117, near_highP: 8.7672 },
    winRateBuckets: { far_lowP: 44.86, mid_P: 43.84, near_highP: 32.58 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(25) });
    data.sort((a,b)=>new Date(a.date)-new Date(b.date));
    if (data.length < 15) throw new Error('Zu wenige Daten');
    const closes = data.map(d=>d.close);
    const n = closes.length;
    // Finde die letzten 10 Tage: war einer davon ein Kompressions-Tag, der noch nicht
    // ausgebrochen ist? Scanne von alt nach neu, trackt offene Kompressions-Level.
    let pending = null;
    for (let d = 2; d < n; d++) {
      const A = closes[d], B = closes[d-1], C = closes[d-2];
      if (Math.abs(A-B) < Math.abs(C-B)) {
        pending = { day: d, longTrigger: Math.max(A,B,C), shortTrigger: Math.min(A,B,C) };
      }
      if (pending && d > pending.day) {
        if (closes[d] > pending.longTrigger) { pending = null; if (d === n-1) return { price: closes[d], direction: 'LONG' }; }
        else if (closes[d] < pending.shortTrigger) { pending = null; if (d === n-1) return { price: closes[d], direction: 'SHORT' }; }
      }
    }
    if (pending) throw new Error('Kompression aktiv seit ' + data[pending.day].date + ', wartet auf Ausbruch über ' + pending.longTrigger.toFixed(2) + ' / unter ' + pending.shortTrigger.toFixed(2));
    throw new Error('Kein aktives Setup');
  `,
  extraHelpers: '',
  defaultWatchlist: 'VOW3.XETRA, BAS.XETRA, DTE.XETRA, CON.XETRA, HEI.XETRA'
},

{
  file: 'SMART-CORPUS-EDGE.html', title: 'Smart Corpus Edge', icon: 'fa-layer-group',
  heading: 'SMART CORPUS EDGE', sub: 'Kerzenkörper-Kompression (NOVEM "Corpus Parvus") · bester Edge im volatilen Regime',
  backtest: { n: 2548, avgRet: 0.3201, winRate: 32.61, sharpeLike: 0.686, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: null, mid_P: null, near_highP: 0.3201 },
    winBuckets: { far_lowP: null, mid_P: null, near_highP: 8.7301 },
    winRateBuckets: { far_lowP: 45.43, mid_P: 43.43, near_highP: 32.61 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(25) });
    data.sort((a,b)=>new Date(a.date)-new Date(b.date));
    if (data.length < 15) throw new Error('Zu wenige Daten');
    const n = data.length;
    let pending = null;
    for (let d = 2; d < n; d++) {
      const bodyA = Math.abs(data[d-1].close - data[d-1].open);
      const bodyB = Math.abs(data[d].close - data[d].open);
      if (bodyB < bodyA) {
        pending = { day: d, longBreak: data[d].close*1.01, shortBreak: data[d].close*0.99 };
      }
      if (pending && d > pending.day) {
        if (data[d].close > pending.longBreak) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'LONG' }; }
        else if (data[d].close < pending.shortBreak) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'SHORT' }; }
      }
    }
    if (pending) throw new Error('Kompression aktiv seit ' + data[pending.day].date + ', wartet auf Ausbruch über ' + pending.longBreak.toFixed(2) + ' / unter ' + pending.shortBreak.toFixed(2));
    throw new Error('Kein aktives Setup');
  `,
  extraHelpers: '',
  defaultWatchlist: 'DHL.XETRA, EOAN.XETRA, MUV2.XETRA, HEN3.XETRA, FRE.XETRA'
},

{
  file: 'SMART-HIDDENSMASH-EDGE.html', title: 'Smart Hidden-Smash Edge', icon: 'fa-ghost',
  heading: 'SMART HIDDEN-SMASH EDGE', sub: 'Stop-Hunt / Liquidity-Trap (NOVEM "Hidden Smash") · bester Edge im mittleren Regime',
  backtest: { n: 10074, avgRet: 0.1859, winRate: 43.39, sharpeLike: 0.584, bestBucket: 'mid_P', robust: true,
    buckets: { far_lowP: null, mid_P: 0.1859, near_highP: null },
    winBuckets: { far_lowP: null, mid_P: 4.8794, near_highP: null },
    winRateBuckets: { far_lowP: 47.49, mid_P: 43.39, near_highP: 33.44 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(10) });
    data.sort((a,b)=>new Date(a.date)-new Date(b.date));
    if (data.length < 2) throw new Error('Zu wenige Daten');
    const today = data[data.length-1], yest = data[data.length-2];
    const bullTrap = today.high > yest.high && today.close < yest.high;
    const bearTrap = today.low < yest.low && today.close > yest.low;
    if (!bullTrap && !bearTrap) throw new Error('Kein Trap-Signal heute');
    return { price: today.close, direction: bullTrap ? 'SHORT' : 'LONG' };
  `,
  extraHelpers: '',
  defaultWatchlist: 'SIE.XETRA, SAP.XETRA, ALV.XETRA, DBK.XETRA, MTX.XETRA'
},

{
  file: 'SMART-VOLUMINA-EDGE.html', title: 'Smart Volumina Edge', icon: 'fa-chart-column',
  heading: 'SMART VOLUMINA EDGE', sub: 'Volumen-Kompressions-Breakout (NOVEM "Volumina") · bester Edge im volatilen Regime',
  backtest: { n: 2621, avgRet: 0.2511, winRate: 31.36, sharpeLike: 0.539, bestBucket: 'near_highP', robust: true,
    buckets: { far_lowP: null, mid_P: 0.214, near_highP: 0.2511 },
    winBuckets: { far_lowP: null, mid_P: 4.9331, near_highP: 9.0256 },
    winRateBuckets: { far_lowP: 45.58, mid_P: 43.57, near_highP: 31.36 } },
  detectorBody: `
    const data = await API.eod.historical(symbol, { from: isoDaysAgo(25) });
    data.sort((a,b)=>new Date(a.date)-new Date(b.date));
    if (data.length < 15) throw new Error('Zu wenige Daten');
    const n = data.length;
    let pending = null;
    for (let d = 5; d < n; d++) {
      if (data[d].volume < data[d-1].volume && data[d].volume > 0) {
        pending = { day: d, longLevel: data[d].close*1.01, shortLevel: data[d].close*0.99 };
      }
      if (pending && d > pending.day) {
        if (data[d].close > pending.longLevel) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'LONG' }; }
        else if (data[d].close < pending.shortLevel) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'SHORT' }; }
      }
    }
    if (pending) throw new Error('Volumen-Kompression aktiv seit ' + data[pending.day].date + ', wartet auf Ausbruch über ' + pending.longLevel.toFixed(2) + ' / unter ' + pending.shortLevel.toFixed(2));
    throw new Error('Kein aktives Setup');
  `,
  extraHelpers: '',
  defaultWatchlist: 'NVDA.US, AMD.US, TSLA.US, VOW3.XETRA, RHM.XETRA'
},

{
  file: 'SMART-ARGENTUM-EDGE.html', title: 'Smart Argentum Edge', icon: 'fa-coins',
  heading: 'SMART ARGENTUM EDGE', sub: 'Cross-sektionaler Relative-Stärke Z-Score (NOVEM "Argentum") · bedingt robuster Edge im mittleren Regime',
  backtest: { n: 16920, avgRet: 0.1749, winRate: 42.88, sharpeLike: 0.545, bestBucket: 'mid_P', robust: true, caveat: true,
    buckets: { far_lowP: null, mid_P: 0.1749, near_highP: null },
    winBuckets: { far_lowP: null, mid_P: 4.9624, near_highP: null },
    winRateBuckets: { far_lowP: 46.87, mid_P: 42.88, near_highP: 33.06 } },
  detectorBody: `
    const UNIVERSE = ['AAPL.US','MSFT.US','GOOGL.US','AMZN.US','NVDA.US','META.US','TSLA.US','JPM.US','JNJ.US','PG.US','SAP.XETRA','SIE.XETRA','ALV.XETRA','BAS.XETRA','DTE.XETRA'];
    const basket = Array.from(new Set([symbol, ...UNIVERSE]));
    const perf20 = {};
    for (const s of basket) {
      try {
        const d = await API.eod.historical(s, { from: isoDaysAgo(35) });
        d.sort((a,b)=>new Date(a.date)-new Date(b.date));
        if (d.length < 21) continue;
        perf20[s] = (d[d.length-1].close - d[d.length-21].close) / d[d.length-21].close;
      } catch(e) { /* skip symbol */ }
    }
    if (perf20[symbol] == null) throw new Error('Keine ausreichenden Daten für ' + symbol);
    const others = Object.entries(perf20).filter(([s])=>s!==symbol).map(([,v])=>v);
    if (others.length < 5) throw new Error('Zu wenig Universum-Daten für Z-Score');
    const uMean = others.reduce((a,b)=>a+b,0)/others.length;
    const spread = perf20[symbol] - uMean;
    const variance = others.reduce((a,b)=>a+Math.pow(b-uMean,2),0)/others.length;
    const sd = Math.max(Math.sqrt(variance), 0.01);
    const zScore = spread / sd;
    let direction = null;
    if (zScore <= -0.75) direction = 'LONG'; else if (zScore >= 0.75) direction = 'SHORT';
    if (!direction) throw new Error('Z-Score ' + zScore.toFixed(2) + ' -- kein Signal (Schwelle ±0.75)');
    const latest = await API.eod.historical(symbol, { from: isoDaysAgo(5) });
    latest.sort((a,b)=>new Date(b.date)-new Date(a.date));
    return { price: latest[0].close, direction };
  `,
  extraHelpers: '',
  defaultWatchlist: 'NVDA.US, TSLA.US, SAP.XETRA, BAS.XETRA'
}

];

function buildTool(spec) {
  const buckets = Object.entries(spec.backtest.buckets).map(([k,v]) => `${k}: ${v === null ? 'null' : v}`).join(', ');
  const winBuckets = Object.entries(spec.backtest.winBuckets).map(([k,v]) => `${k}: ${v === null ? 'null' : v}`).join(', ');
  const winRateBuckets = Object.entries(spec.backtest.winRateBuckets).map(([k,v]) => `${k}: ${v === null ? 'null' : v}`).join(', ');
  return `${SHARED_HEAD(spec.title)}
  <header class="bg-white dark:bg-gray-900 shadow-lg">
    <div class="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
      <div>
        <h1 class="text-lg md:text-xl font-bold"><i class="fa-solid ${spec.icon} text-primary mr-2"></i>${spec.heading}</h1>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">${spec.sub}</p>
      </div>
      <button onclick="document.documentElement.classList.toggle('dark')" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><i class="fa-solid fa-circle-half-stroke text-lg"></i></button>
    </div>
  </header>
  <main class="max-w-3xl mx-auto px-4 py-6">
    <div class="bg-white dark:bg-gray-900 rounded-lg shadow p-4 mb-4 text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
      <i class="fa-solid fa-circle-info mr-1 text-primary"></i>
      Backtest-validiert (<a href="SMART-TARGET-SCANNER.html" class="text-primary underline">Smart-Target-Methodik</a>):
      n=${spec.backtest.n.toLocaleString('de-DE')} im Ziel-Bucket "<b>${spec.backtest.bestBucket}</b>", Sharpe-ähnlich
      <b>${spec.backtest.sharpeLike}</b>, WinRate ${spec.backtest.winRate}% (Median-Trade ist wie bei allen asymmetrischen
      Setups dieses Projekts negativ -- der Mittelwert ist positiv durch wenige, deutlich grössere Gewinner).
      ${spec.backtest.caveat ? '<b class="text-amber-600">Hinweis: schwächt über die Zeit leicht ab (noch positiv in beiden Zeithälften, aber nicht so stabil wie die anderen 9 Tools dieser Serie).</b>' : ''}
      ${spec.note ? `<br>${spec.note}` : ''}
    </div>

    <div class="bg-white dark:bg-gray-900 rounded-lg shadow p-4 mb-4">
      <label class="text-xs text-gray-500 dark:text-gray-400">Symbole (Komma-getrennt)</label>
      <div class="flex gap-2 mt-1">
        <input id="symbolInput" type="text" value="${spec.defaultWatchlist}" class="flex-1 h-10 px-3 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm">
        <button id="scanBtn" onclick="runScan()" class="h-10 px-5 bg-primary text-white rounded-md text-sm font-semibold hover:opacity-90">
          <i class="fa-solid fa-magnifying-glass mr-1"></i>SCAN
        </button>
      </div>
    </div>

    <div id="status" class="text-xs text-gray-400 mb-3"></div>
    <div id="results"></div>

    <p class="text-xs text-gray-400 mt-4">Keine Anlageberatung. Smart Stop/Target und Vola-Bucket basieren auf historischer Drift/Volatilität -- keine Garantie für zukünftiges Verhalten.</p>
  </main>
<script>
  const BACKTEST = { n: ${spec.backtest.n}, avgRet: ${spec.backtest.avgRet}, winRate: ${spec.backtest.winRate}, sharpeLike: ${spec.backtest.sharpeLike}, bestBucket: '${spec.backtest.bestBucket}', robust: ${spec.backtest.robust}, buckets: { ${buckets} }, winBuckets: { ${winBuckets} }, winRateBuckets: { ${winRateBuckets} } };
${SHARED_SCRIPT_HEAD}
${spec.extraHelpers}
${RESULT_CARD}

  async function detectSignal(symbol) {
${spec.detectorBody}
  }

  async function runScan() {
    const symbols = document.getElementById('symbolInput').value.split(',').map(s=>s.trim()).filter(Boolean);
    document.getElementById('scanBtn').disabled = true;
    document.getElementById('results').innerHTML = '';
    const status = document.getElementById('status');
    for (const sym of symbols) {
      status.textContent = 'Scanne ' + sym + '...';
      try {
        const { price, direction } = await detectSignal(sym);
        const volRegime = await getVolRegime(sym, price, direction);
        const vts = smartStopTarget(price, direction, volRegime ? volRegime.bucket : BACKTEST.bestBucket);
        renderCard(sym, price, direction, vts, volRegime);
      } catch (e) {
        const container = document.getElementById('results');
        const card = document.createElement('div');
        card.className = 'bg-gray-50 dark:bg-gray-800 rounded-lg p-3 mb-2 text-xs text-gray-500';
        card.innerHTML = '<b>' + sym + ':</b> ' + e.message;
        container.appendChild(card);
      }
    }
    status.textContent = 'Fertig: ' + symbols.length + ' Symbole geprüft.';
    document.getElementById('scanBtn').disabled = false;
  }
</script>
</body>
</html>
`;
}

for (const spec of TOOLS) {
  const html = buildTool(spec);
  const outPath = path.join(OUT_DIR, spec.file);
  fs.writeFileSync(outPath, html);
  console.log('Written:', outPath);
}
console.log('\\nDone --', TOOLS.length, 'tools generated.');
