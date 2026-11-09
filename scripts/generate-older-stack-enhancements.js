// scripts/generate-older-stack-enhancements.js
// Batch 2 of the Smart-Target rollout: enhance 9 existing NOVEM live tools + TREND-RIDER
// (the "older stack") with a self-contained Smart-Target panel, injected right after <body>,
// WITHOUT touching any existing rendering code in these files (zero risk to proven logic).
//
// Honesty discipline (this is the "audit" the user asked for): only the 6 signals whose
// (signal, bucket) combo passed the strict robustness filter (data/smart-target-master-result.json)
// get a "✅ validiert" badge with real avgRet numbers. Body-Slam and Peak-Valley get an explicit
// "⚠️ GEPRÜFT, NICHT ROBUST" badge (real numbers shown, but flagged, not sold as an edge).
// Consultus-Weekly gets a documentation-only note (no stop-based exit exists for it at all --
// never pretend otherwise). TREND-RIDER gets a pure informational GBM context widget with NO
// backtest claim, since its EMA-ribbon signal was never run through this methodology.

const fs = require('fs');
const path = require('path');

const TRADING_DIR = 'E:\\mcp-server\\trading';

const SHARED_SCRIPT = `
<!-- ============== SMART-TARGET ENHANCEMENT (added, does not touch existing logic) ============== -->
<div id="st_panel" style="max-width:900px;margin:14px auto;padding:14px 16px;background:#fff;border:1px solid #d6e2ea;border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#1c2e34;">
  <div style="font-weight:700;letter-spacing:1px;margin-bottom:6px;">🎯 SMART-TARGET ENHANCEMENT</div>
  <div id="st_intro" style="font-size:11px;color:#5f7277;line-height:1.6;margin-bottom:10px;"></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <input id="st_symbolInput" type="text" placeholder="Symbol(e), Komma-getrennt" style="flex:1;min-width:200px;height:34px;padding:0 10px;border:1px solid #d6e2ea;border-radius:4px;font-family:inherit;font-size:12px;">
    <button id="st_scanBtn" onclick="st_runScan()" style="height:34px;padding:0 16px;background:#0e7490;color:#fff;border:none;border-radius:4px;font-weight:700;cursor:pointer;">SMART-SCAN</button>
  </div>
  <div id="st_status" style="font-size:10px;color:#9aa5a9;margin-top:6px;"></div>
  <div id="st_results" style="margin-top:8px;"></div>
</div>
<script>
(function(){
  window.ST_BASE = 'https://glow-up-gemini.replit.app';
  async function st_getJSON(p, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await fetch(ST_BASE + p + qs);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  window.ST_API = { eod: { historical: (s,p) => st_getJSON('/eod/historical/'+s, p) } };
  window.st_isoDaysAgo = function(n) { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

  window.st_normCDF = function(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign=x<0?-1:1; const z=Math.abs(x)/Math.sqrt(2); const t=1/(1+p*z);
    const erf=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-z*z);
    return 0.5*(1+sign*erf);
  };
  window.st_estimateSigmaMu = function(prices) {
    const lr=[]; for(let i=1;i<prices.length;i++) if(prices[i]>0&&prices[i-1]>0) lr.push(Math.log(prices[i]/prices[i-1]));
    if (lr.length<20) return null;
    const mean=lr.reduce((a,b)=>a+b,0)/lr.length;
    const variance=lr.reduce((a,b)=>a+Math.pow(b-mean,2),0)/(lr.length-1);
    const sigma=Math.sqrt(variance*252); const mu=mean*252+0.5*sigma*sigma;
    return { sigma, mu };
  };
  window.st_probHitTarget = function(S,K,mu,sigma,T) {
    if (S===K) return 1.0; if (sigma<=0||T<=0) return 0.0;
    const v=mu-0.5*sigma*sigma, b=Math.abs(Math.log(K/S)), sst=sigma*Math.sqrt(T);
    const d1=(-b+v*T)/sst, d2=(-b-v*T)/sst;
    return Math.min(Math.max(st_normCDF(d1)+Math.exp((2*v*b)/(sigma*sigma))*st_normCDF(d2),0),1);
  };
  window.st_volBucketOf = function(p){ return p<0.40?'far_lowP':p<0.70?'mid_P':'near_highP'; };
  window.ST_VOL_LABEL = { far_lowP:'🔴 Ruhiges Regime', mid_P:'🟡 Mittleres Regime', near_highP:'🟢 Volatiles Regime' };
  window.ST_STOP_PCT = 4; window.ST_HOLD_DAYS = 10; window.ST_T_YEARS = 10/252;

  window.st_getVolRegime = async function(symbol, price, direction) {
    try {
      const hist = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(400) });
      const closes = (Array.isArray(hist)?hist:[]).map(h=>h.close).filter(c=>c>0);
      if (closes.length < 20) return null;
      const params = st_estimateSigmaMu(closes);
      if (!params) return null;
      const stopLevel = direction==='LONG' ? price*(1-ST_STOP_PCT/100) : price*(1+ST_STOP_PCT/100);
      const pTouchStop = st_probHitTarget(price, stopLevel, params.mu, params.sigma, ST_T_YEARS);
      return { pTouchStop, sigma: params.sigma, bucket: st_volBucketOf(pTouchStop) };
    } catch(e) { console.error('st_getVolRegime failed', e); return null; }
  };
})();
</script>
`;

function toolScript(spec) {
  const buckets = Object.entries(spec.backtest.buckets).map(([k,v]) => `${k}: ${v === null ? 'null' : v}`).join(', ');
  return `
<script>
const ST_BACKTEST = { n: ${spec.backtest.n}, avgRet: ${spec.backtest.avgRet}, winRate: ${spec.backtest.winRate}, sharpeLike: ${spec.backtest.sharpeLike}, bestBucket: '${spec.backtest.bestBucket}', status: '${spec.backtest.status}', buckets: { ${buckets} } };
document.getElementById('st_intro').innerHTML = ${JSON.stringify(spec.introHTML)};

function st_smartStopTarget(price, direction, bucket) {
  const sign = direction==='LONG'?1:-1;
  const bucketAvgRet = ST_BACKTEST.buckets[bucket] != null ? ST_BACKTEST.buckets[bucket] : ST_BACKTEST.avgRet;
  const target = price*(1+sign*(bucketAvgRet/100));
  const stop = price*(1-sign*(ST_STOP_PCT/100));
  return { target: target.toFixed(2), stop: stop.toFixed(2), bucketAvgRet };
}

function st_renderCard(sym, price, direction, vts, volRegime) {
  const container = document.getElementById('st_results');
  const card = document.createElement('div');
  card.style.cssText = 'background:#eaf1f6;border:1px solid #d6e2ea;border-radius:6px;padding:10px;margin-bottom:8px;';
  const statusBadge = ST_BACKTEST.status === 'validated'
    ? '<span style="color:#15803d;font-weight:700;">✅ validiert, robust</span>'
    : ST_BACKTEST.status === 'warning'
      ? '<span style="color:#b91c1c;font-weight:700;">⚠️ geprüft, NICHT robust (reale Zahlen, aber Edge schwächt stark ab)</span>'
      : '<span style="color:#b45309;font-weight:700;">ℹ️ informativ, kein eigener Backtest für dieses Signal</span>';
  card.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><b>' + sym + '</b><span style="font-weight:700;color:' + (direction==='LONG'?'#15803d':'#b91c1c') + ';">' + direction + '</span></div>' +
    '<div>Entry: <b>' + price.toFixed(2) + '</b> &nbsp; Smart Target: <b style="color:#0e7490;">' + vts.target + '</b> &nbsp; Smart Stop (-4%): <b style="color:#b45309;">' + vts.stop + '</b></div>' +
    (volRegime ? '<div style="margin-top:4px;font-size:10.5px;color:#5f7277;">P(Touch Stop in 10d) = ' + (volRegime.pTouchStop*100).toFixed(0) + '% (σ=' + (volRegime.sigma*100).toFixed(1) + '%) · ' + ST_VOL_LABEL[volRegime.bucket] + '</div>' : '') +
    '<div style="margin-top:4px;font-size:10px;color:#9aa5a9;">' + statusBadge + ' -- n=' + ST_BACKTEST.n.toLocaleString('de-DE') + ', Ø' + ST_BACKTEST.avgRet + '%, Sharpe ' + ST_BACKTEST.sharpeLike + ' (Bucket: ' + ST_BACKTEST.bestBucket + ')</div>';
  container.appendChild(card);
}

async function st_detectSignal(symbol) {
${spec.detectorBody}
}

async function st_runScan() {
  const symbols = document.getElementById('st_symbolInput').value.split(',').map(s=>s.trim()).filter(Boolean);
  document.getElementById('st_scanBtn').disabled = true;
  document.getElementById('st_results').innerHTML = '';
  const status = document.getElementById('st_status');
  for (const sym of symbols) {
    status.textContent = 'Scanne ' + sym + '...';
    try {
      const { price, direction } = await st_detectSignal(sym);
      const volRegime = await st_getVolRegime(sym, price, direction);
      const vts = st_smartStopTarget(price, direction, volRegime ? volRegime.bucket : ST_BACKTEST.bestBucket);
      st_renderCard(sym, price, direction, vts, volRegime);
    } catch (e) {
      const container = document.getElementById('st_results');
      const card = document.createElement('div');
      card.style.cssText = 'background:#f4f7fb;border-radius:4px;padding:6px 10px;margin-bottom:4px;font-size:10.5px;color:#9aa5a9;';
      card.textContent = sym + ': ' + e.message;
      container.appendChild(card);
    }
  }
  status.textContent = 'Fertig: ' + symbols.length + ' Symbole geprüft.';
  document.getElementById('st_scanBtn').disabled = false;
}
document.getElementById('st_symbolInput').value = '${spec.defaultWatchlist}';
</script>
`;
}

const ENHANCEMENTS = [

{
  file: 'ARGENTUM-DAILY-FINAL (1).html', defaultWatchlist: 'NVDA.US, TSLA.US, SAP.XETRA, BAS.XETRA',
  backtest: { n: 16920, avgRet: 0.1749, winRate: 42.88, sharpeLike: 0.545, bestBucket: 'mid_P', status: 'validated', buckets: { far_lowP: null, mid_P: 0.1749, near_highP: null } },
  introHTML: 'Backtest-validiert (siehe <a href="https://babybounce500.github.io/genitus-midpoint-terminal/smart-target-master-report.html" target="_blank">Master-Report</a>): Der stärkste Bucket von Argentum ist "mid_P", Sharpe 0.545, robust über beide Zeithälften (aber schwächt leicht ab -- siehe Report).',
  detectorBody: `
  const UNIVERSE = ['AAPL.US','MSFT.US','GOOGL.US','AMZN.US','NVDA.US','META.US','TSLA.US','JPM.US','JNJ.US','PG.US','SAP.XETRA','SIE.XETRA','ALV.XETRA','BAS.XETRA','DTE.XETRA'];
  const basket = Array.from(new Set([symbol, ...UNIVERSE]));
  const perf20 = {};
  for (const s of basket) {
    try {
      const d = await ST_API.eod.historical(s, { from: st_isoDaysAgo(35) });
      d.sort((a,b)=>new Date(a.date)-new Date(b.date));
      if (d.length < 21) continue;
      perf20[s] = (d[d.length-1].close - d[d.length-21].close) / d[d.length-21].close;
    } catch(e) {}
  }
  if (perf20[symbol] == null) throw new Error('Keine ausreichenden Daten');
  const others = Object.entries(perf20).filter(([s])=>s!==symbol).map(([,v])=>v);
  if (others.length < 5) throw new Error('Zu wenig Universum-Daten');
  const uMean = others.reduce((a,b)=>a+b,0)/others.length;
  const spread = perf20[symbol] - uMean;
  const variance = others.reduce((a,b)=>a+Math.pow(b-uMean,2),0)/others.length;
  const sd = Math.max(Math.sqrt(variance), 0.01);
  const zScore = spread / sd;
  let direction = null;
  if (zScore <= -0.75) direction = 'LONG'; else if (zScore >= 0.75) direction = 'SHORT';
  if (!direction) throw new Error('Z-Score ' + zScore.toFixed(2) + ' -- kein Signal');
  const latest = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(5) });
  latest.sort((a,b)=>new Date(b.date)-new Date(a.date));
  return { price: latest[0].close, direction };
  `
},

{
  file: 'HIDDEN-SMASH-FINAL (1).html', defaultWatchlist: 'SIE.XETRA, SAP.XETRA, ALV.XETRA, DBK.XETRA',
  backtest: { n: 10074, avgRet: 0.1859, winRate: 43.39, sharpeLike: 0.584, bestBucket: 'mid_P', status: 'validated', buckets: { far_lowP: null, mid_P: 0.1859, near_highP: null } },
  introHTML: 'Backtest-validiert: Der stärkste Bucket von Hidden-Smash ist "mid_P", Sharpe 0.584, robust über beide Zeithälften.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(10) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 2) throw new Error('Zu wenige Daten');
  const today = data[data.length-1], yest = data[data.length-2];
  const bullTrap = today.high > yest.high && today.close < yest.high;
  const bearTrap = today.low < yest.low && today.close > yest.low;
  if (!bullTrap && !bearTrap) throw new Error('Kein Trap-Signal heute');
  return { price: today.close, direction: bullTrap ? 'SHORT' : 'LONG' };
  `
},

{
  file: 'CONSULTUS-BULK-DAILY (1).html', defaultWatchlist: 'VOW3.XETRA, BAS.XETRA, DTE.XETRA, CON.XETRA, HEI.XETRA',
  backtest: { n: 2532, avgRet: 0.3458, winRate: 32.58, sharpeLike: 0.739, bestBucket: 'near_highP', status: 'validated', buckets: { far_lowP: null, mid_P: 0.245, near_highP: 0.3458 } },
  introHTML: 'Backtest-validiert: Der stärkste Bucket von Consultus Daily ist "near_highP", Sharpe 0.739, robust.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(25) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 15) throw new Error('Zu wenige Daten');
  const closes = data.map(d=>d.close);
  const n = closes.length;
  let pending = null;
  for (let d = 2; d < n; d++) {
    const A = closes[d], B = closes[d-1], C = closes[d-2];
    if (Math.abs(A-B) < Math.abs(C-B)) pending = { day: d, longTrigger: Math.max(A,B,C), shortTrigger: Math.min(A,B,C) };
    if (pending && d > pending.day) {
      if (closes[d] > pending.longTrigger) { pending = null; if (d === n-1) return { price: closes[d], direction: 'LONG' }; }
      else if (closes[d] < pending.shortTrigger) { pending = null; if (d === n-1) return { price: closes[d], direction: 'SHORT' }; }
    }
  }
  if (pending) throw new Error('Kompression aktiv seit ' + data[pending.day].date + ', wartet auf Ausbruch über ' + pending.longTrigger.toFixed(2) + ' / unter ' + pending.shortTrigger.toFixed(2));
  throw new Error('Kein aktives Setup');
  `
},

{
  file: 'CORPUS-PARVUS (1).html', defaultWatchlist: 'DHL.XETRA, EOAN.XETRA, MUV2.XETRA, HEN3.XETRA, FRE.XETRA',
  backtest: { n: 2548, avgRet: 0.3201, winRate: 32.61, sharpeLike: 0.686, bestBucket: 'near_highP', status: 'validated', buckets: { far_lowP: null, mid_P: null, near_highP: 0.3201 } },
  introHTML: 'Backtest-validiert: Der stärkste Bucket von Corpus Parvus ist "near_highP", Sharpe 0.686, robust.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(25) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 15) throw new Error('Zu wenige Daten');
  const n = data.length;
  let pending = null;
  for (let d = 2; d < n; d++) {
    const bodyA = Math.abs(data[d-1].close - data[d-1].open);
    const bodyB = Math.abs(data[d].close - data[d].open);
    if (bodyB < bodyA) pending = { day: d, longBreak: data[d].close*1.01, shortBreak: data[d].close*0.99 };
    if (pending && d > pending.day) {
      if (data[d].close > pending.longBreak) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'LONG' }; }
      else if (data[d].close < pending.shortBreak) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'SHORT' }; }
    }
  }
  if (pending) throw new Error('Kompression aktiv seit ' + data[pending.day].date + ', wartet auf Ausbruch über ' + pending.longBreak.toFixed(2) + ' / unter ' + pending.shortBreak.toFixed(2));
  throw new Error('Kein aktives Setup');
  `
},

{
  file: 'DENARIUS-FINAL_html.html', defaultWatchlist: 'AMD.US, NVDA.US, TSLA.US, RHM.XETRA',
  backtest: { n: 5057, avgRet: 0.4668, winRate: 34.19, sharpeLike: 0.995, bestBucket: 'near_highP', status: 'validated', buckets: { far_lowP: null, mid_P: 0.209, near_highP: 0.4668 } },
  introHTML: 'Backtest-validiert: Der stärkste Bucket von Denarius ist "near_highP", Sharpe 0.995 -- einer der stärksten Edges der ganzen Suite.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(14) });
  data.sort((a,b)=>new Date(b.date)-new Date(a.date));
  if (data.length < 3) throw new Error('Zu wenige Daten');
  const price = data[0].close;
  const spread = price / data[2].close;
  return { price, direction: spread >= 1.0 ? 'LONG' : 'SHORT' };
  `
},

{
  file: 'VOLUMINA-FINAL (1).html', defaultWatchlist: 'NVDA.US, AMD.US, TSLA.US, VOW3.XETRA, RHM.XETRA',
  backtest: { n: 2621, avgRet: 0.2511, winRate: 31.36, sharpeLike: 0.539, bestBucket: 'near_highP', status: 'validated', buckets: { far_lowP: null, mid_P: 0.214, near_highP: 0.2511 } },
  introHTML: 'Backtest-validiert: Der stärkste Bucket von Volumina ist "near_highP", Sharpe 0.539, robust.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(25) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 15) throw new Error('Zu wenige Daten');
  const n = data.length;
  let pending = null;
  for (let d = 5; d < n; d++) {
    if (data[d].volume < data[d-1].volume && data[d].volume > 0) pending = { day: d, longLevel: data[d].close*1.01, shortLevel: data[d].close*0.99 };
    if (pending && d > pending.day) {
      if (data[d].close > pending.longLevel) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'LONG' }; }
      else if (data[d].close < pending.shortLevel) { pending = null; if (d === n-1) return { price: data[d].close, direction: 'SHORT' }; }
    }
  }
  if (pending) throw new Error('Volumen-Kompression aktiv seit ' + data[pending.day].date + ', wartet auf Ausbruch über ' + pending.longLevel.toFixed(2) + ' / unter ' + pending.shortLevel.toFixed(2));
  throw new Error('Kein aktives Setup');
  `
},

{
  file: 'PEAK-VALLEY-BULK-FINAL (1).html', defaultWatchlist: 'SAP.XETRA, SIE.XETRA, BMW.XETRA, IFX.XETRA',
  backtest: { n: 2524, avgRet: 0.301, winRate: 0, sharpeLike: 0.301, bestBucket: 'near_highP', status: 'warning', buckets: { far_lowP: null, mid_P: null, near_highP: 0.301 } },
  introHTML: '<b style="color:#b91c1c;">Audit-Ergebnis: Peak-Valley ist NICHT robust</b> -- selbst der beste Bucket (near_highP) fällt von Sharpe 0.476 (ältere Hälfte) auf 0.156 (neuere Hälfte). Reale Zahlen unten, aber als Warnung markiert, nicht als Edge verkauft.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(10) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 3) throw new Error('Zu wenige Daten');
  const n = data.length;
  const c0 = data[n-1].close, c1 = data[n-2].close, c2 = data[n-3].close;
  const isValley = c1 === Math.min(c0,c1,c2) && c1 !== c0 && c1 !== c2;
  const isPeak = c1 === Math.max(c0,c1,c2) && c1 !== c0 && c1 !== c2;
  if (!isValley && !isPeak) throw new Error('Kein Peak/Valley-Signal');
  return { price: c0, direction: isValley ? 'LONG' : 'SHORT' };
  `
},

{
  file: 'BODY-SLAM-FINAL-v2.html', defaultWatchlist: 'TSLA.US, NVDA.US, GME.US, RHM.XETRA',
  backtest: { n: 444, avgRet: 0.5815, winRate: 50, sharpeLike: 2.262, bestBucket: 'far_lowP', status: 'warning', buckets: { far_lowP: 0.5815, mid_P: 0.3282, near_highP: null } },
  introHTML: '<b style="color:#b91c1c;">Audit-Ergebnis: Body-Slam ist NICHT robust, trotz spektakulärer Headline-Sharpe (2.262)</b> -- die ältere Hälfte zeigt Sharpe 3.545, die neuere nur noch 0.467 (n ebenfalls klein: 444 Trades total). Klassisches Beispiel, warum der Zweiperioden-Check Pflicht ist. Reale Zahlen unten, explizit als Warnung markiert.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(45) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 21) throw new Error('Zu wenige Daten');
  const closes = data.map(d=>d.close);
  const n = closes.length;
  const sma20 = closes.slice(n-20,n).reduce((a,b)=>a+b,0)/20;
  const stretchPct = ((closes[n-1]-sma20)/sma20)*100;
  if (Math.abs(stretchPct) < 6) throw new Error('Kein Signal (Stretch ' + stretchPct.toFixed(1) + '%, Schwelle ±6%)');
  return { price: closes[n-1], direction: stretchPct <= -6 ? 'LONG' : 'SHORT' };
  `
},

{
  file: 'CONSULTUS-BULK-WEEKLY (1).html', defaultWatchlist: 'SAP.XETRA, SIE.XETRA, ALV.XETRA',
  backtest: { n: 3798, avgRet: -0.374, winRate: 0, sharpeLike: -0.374, bestBucket: 'n/a (horizon_4w)', status: 'warning', buckets: { far_lowP: null, mid_P: null, near_highP: null } },
  introHTML: '<b style="color:#b91c1c;">Audit-Ergebnis: Consultus Weekly hat KEINEN Edge</b> -- die einzige im Original-Backtest getestete Exit-Regel (horizon_4w, kein Stop) zeigt Sharpe -0.374. Nutzt zudem keinen Stop-basierten Exit, daher ist die Smart-Target-Vola-Bucket-Methodik hier gar nicht erst anwendbar (siehe Master-Report). Dieses Panel zeigt live trotzdem den rohen Signal-Zustand, ohne jede Zielkurs-Behauptung.',
  detectorBody: `
  const data = await ST_API.eod.historical(symbol, { from: st_isoDaysAgo(40) });
  data.sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (data.length < 15) throw new Error('Zu wenige Daten');
  // Wochen-Resampling: letzter Handelstag pro ISO-Woche
  const weekClose = new Map();
  for (const d of data) {
    const dt = new Date(d.date+'T00:00:00Z');
    const dow = dt.getUTCDay() || 7;
    const thu = new Date(dt); thu.setUTCDate(dt.getUTCDate()+(4-dow));
    const key = thu.getUTCFullYear()+'-W'+Math.ceil((((thu-new Date(Date.UTC(thu.getUTCFullYear(),0,1)))/86400000)+1)/7);
    weekClose.set(key, d.close);
  }
  const weeks = Array.from(weekClose.values());
  if (weeks.length < 3) throw new Error('Zu wenige Wochen');
  const n = weeks.length;
  const A = weeks[n-1], B = weeks[n-2], C = weeks[n-3];
  if (!(Math.abs(A-B) < Math.abs(C-B))) throw new Error('Kein Kompressions-Setup diese Woche');
  throw new Error('Kompression erkannt (A=' + A.toFixed(2) + ' B=' + B.toFixed(2) + ' C=' + C.toFixed(2) + ') -- wartet auf Wochen-Ausbruch über ' + Math.max(A,B,C).toFixed(2) + ' / unter ' + Math.min(A,B,C).toFixed(2) + '. Kein validierter Edge, nur Status-Anzeige.');
  `
}

];

for (const spec of ENHANCEMENTS) {
  const filePath = path.join(TRADING_DIR, spec.file);
  let html = fs.readFileSync(filePath, 'utf8');
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (!bodyMatch) { console.error('No <body> tag found in', spec.file); continue; }
  const insertPos = bodyMatch.index + bodyMatch[0].length;
  const injection = SHARED_SCRIPT + toolScript(spec);
  html = html.slice(0, insertPos) + injection + html.slice(insertPos);
  fs.writeFileSync(filePath, html);
  console.log('Enhanced:', spec.file);
}

// ---------- 10th enhancement: TREND-RIDER.html -- informational-only, no direction/target claim ----------
// The EMA-ribbon signal was never run through the Smart-Target methodology, so this does NOT
// pretend to have a validated target/stop for it. Shows only the raw GBM vola context (sigma,
// P(touch) of a -4% move either way, bucket) as supplementary info for whatever the ribbon itself says.
{
  const trPath = path.join(TRADING_DIR, 'TREND-RIDER.html');
  let html = fs.readFileSync(trPath, 'utf8');
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const insertPos = bodyMatch.index + bodyMatch[0].length;
    const injection = SHARED_SCRIPT + `
<script>
document.getElementById('st_intro').innerHTML = 'Informativ -- das EMA-Ribbon-Signal dieses Tools wurde NICHT durch die Smart-Target-Methodik gebacktestet. Zeigt nur den rohen GBM-Vola-Kontext (σ, P(Touch ±4% in 10 Tagen), Regime) als Zusatzinfo zum Ribbon, keine eigene Zielkurs-Behauptung.';

async function st_runScan() {
  const symbols = document.getElementById('st_symbolInput').value.split(',').map(s=>s.trim()).filter(Boolean);
  document.getElementById('st_scanBtn').disabled = true;
  document.getElementById('st_results').innerHTML = '';
  const status = document.getElementById('st_status');
  for (const sym of symbols) {
    status.textContent = 'Scanne ' + sym + '...';
    try {
      const hist = await ST_API.eod.historical(sym, { from: st_isoDaysAgo(400) });
      const closes = (Array.isArray(hist)?hist:[]).map(h=>h.close).filter(c=>c>0);
      if (closes.length < 20) throw new Error('Zu wenige Daten');
      const price = closes[closes.length-1];
      const params = st_estimateSigmaMu(closes);
      if (!params) throw new Error('Sigma/Mu nicht schätzbar');
      const T = 10/252;
      const pUp = st_probHitTarget(price, price*1.04, params.mu, params.sigma, T);
      const pDown = st_probHitTarget(price, price*0.96, params.mu, params.sigma, T);
      const pTouch = Math.max(pUp, pDown);
      const bucket = st_volBucketOf(pTouch);
      const card = document.createElement('div');
      card.style.cssText = 'background:#eaf1f6;border:1px solid #d6e2ea;border-radius:6px;padding:10px;margin-bottom:8px;';
      card.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><b>' + sym + '</b><span>' + price.toFixed(2) + '</span></div>' +
        '<div style="font-size:10.5px;color:#5f7277;">σ=' + (params.sigma*100).toFixed(1) + '% · P(Touch ±4% in 10d) = ' + (pTouch*100).toFixed(0) + '% · ' + ST_VOL_LABEL[bucket] + '</div>';
      document.getElementById('st_results').appendChild(card);
    } catch (e) {
      const card = document.createElement('div');
      card.style.cssText = 'background:#f4f7fb;border-radius:4px;padding:6px 10px;margin-bottom:4px;font-size:10.5px;color:#9aa5a9;';
      card.textContent = sym + ': ' + e.message;
      document.getElementById('st_results').appendChild(card);
    }
  }
  status.textContent = 'Fertig: ' + symbols.length + ' Symbole geprüft.';
  document.getElementById('st_scanBtn').disabled = false;
}
document.getElementById('st_symbolInput').value = 'AAPL.US, NVDA.US, SAP.XETRA, SIE.XETRA';
</script>
`;
    html = html.slice(0, insertPos) + injection + html.slice(insertPos);
    fs.writeFileSync(trPath, html);
    console.log('Enhanced: TREND-RIDER.html (informational-only)');
  } else console.error('No <body> tag found in TREND-RIDER.html');
}

console.log('\\nDone --', ENHANCEMENTS.length + 1, 'older-stack files enhanced.');
