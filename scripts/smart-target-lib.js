// scripts/smart-target-lib.js
// Shared GBM / first-passage math for volatility-normalized ("smart") targets and stops.
// Ported 1:1 from the live Target-Scanner (mcp-server/trading/probability-cone-scanner.html)
// so backtest diagnostics stay numerically consistent with what that tool actually shows --
// not a re-derivation with different constants. Pure Node-compatible, no DOM.

// Normal CDF (Abramowitz & Stegun 26.2.17) -- identical to the live tool's normCDF().
function normCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

// Annualized sigma/mu from a trailing price series (log returns) -- identical to the live
// tool's estimateParams(). Needs >=20 log-returns (i.e. >=21 prices); returns null otherwise.
function estimateParams(prices) {
  const logReturns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > 0 && prices[i - 1] > 0) logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const n = logReturns.length;
  if (n < 20) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / n;
  const variance = logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  const sigma = Math.sqrt(variance * 252);
  const mu = mean * 252 + 0.5 * sigma * sigma;
  return { sigma, mu };
}

// First-passage probability of touching level K starting at S0 within T years (reflection
// principle) -- identical to the live tool's probHitTarget(). Direction-agnostic: works the
// same whether K is above (short's stop / long's target) or below (long's stop) S0.
function probHitTarget(S, K, mu, sigma, T) {
  if (S === K) return 1.0;
  if (sigma <= 0 || T <= 0) return 0.0;
  const v = mu - 0.5 * sigma * sigma;
  const b = Math.abs(Math.log(K / S));
  const sigmaSqrtT = sigma * Math.sqrt(T);
  const d1 = (-b + v * T) / sigmaSqrtT;
  const d2 = (-b - v * T) / sigmaSqrtT;
  const pTouch = normCDF(d1) + Math.exp((2 * v * b) / (sigma * sigma)) * normCDF(d2);
  return Math.min(Math.max(pTouch, 0), 1);
}

// Price level exactly k (log-scale) standard deviations away over horizon T years.
function sigmaLevel(S0, sigma, T, k, direction) {
  const dist = sigma * Math.sqrt(T) * k;
  return direction === 'up' ? S0 * Math.exp(dist) : S0 * Math.exp(-dist);
}

module.exports = { normCDF, estimateParams, probHitTarget, sigmaLevel };
