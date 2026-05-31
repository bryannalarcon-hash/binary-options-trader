/**
 * Implied distribution math — Breeden-Litzenberger over a binary-option strike
 * chain, plus the implied mean and standard deviation.
 *
 * A Yes token pays $1 iff the underlying closes at-or-above its strike, so its
 * price p_i (in cents/100) IS the risk-neutral probability P(S_T >= K_i). The
 * chain of (K_i, p_i) therefore traces the implied CDF (F(K_i) = 1 - p_i), and
 * the discrete slope between adjacent strikes is the implied PDF:
 *
 *     f_i = (p_i - p_{i+1}) / (K_{i+1} - K_i)     over [K_i, K_{i+1}]
 *
 * Pure + framework-free so it can be unit-tested directly and reused by the
 * landing hero and any chart. Strikes are in cents; Yes prices in cents (0..100).
 */

export interface ImpliedStrike {
  /** Strike in cents (e.g. 32000 == $320.00). */
  strike: number;
  /** Live Yes price in cents (0..100). */
  yes: number;
}

export interface ImpliedDistributionResult {
  /** One probability-mass bar per adjacent strike pair. */
  bars: { lo: number; hi: number; mid: number; density: number; prob: number }[];
  /** Lowest / highest strike in the chain (cents). */
  minK: number;
  maxK: number;
  /** Peak bar density (for normalizing a plot's y-axis). */
  maxDensity: number;
  /** Probability-weighted mean close (cents), normalized to the visible mass. */
  mean: number;
  /** Standard deviation of the visible distribution (cents) — the ±1σ range. */
  std: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Derive the implied distribution from a strike chain. Returns null when there
 * are fewer than two usable strikes (no slope to take) — callers render an
 * honest empty state rather than inventing a curve.
 */
export function computeImpliedDistribution(
  input: ImpliedStrike[],
): ImpliedDistributionResult | null {
  if (!input || input.length < 2) return null;

  // Sort ascending by strike; convert Yes cents → probability ∈ [0,1].
  const sorted = input
    .map((s) => ({ strike: s.strike, p: clamp(s.yes, 0, 100) / 100 }))
    .filter((s) => Number.isFinite(s.strike) && Number.isFinite(s.p))
    .sort((a, b) => a.strike - b.strike);
  if (sorted.length < 2) return null;

  // Yes price must be non-increasing in strike; clip noise so a single
  // mispriced strike can't produce a negative density.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.p > sorted[i - 1]!.p) sorted[i]!.p = sorted[i - 1]!.p;
  }

  const bars: ImpliedDistributionResult["bars"] = [];
  let probSum = 0;
  let meanNum = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const k0 = sorted[i]!.strike;
    const k1 = sorted[i + 1]!.strike;
    const width = k1 - k0;
    if (width <= 0) continue;
    const prob = Math.max(0, sorted[i]!.p - sorted[i + 1]!.p);
    const mid = (k0 + k1) / 2;
    bars.push({ lo: k0, hi: k1, mid, density: prob / width, prob });
    probSum += prob;
    meanNum += mid * prob;
  }
  if (bars.length === 0) return null;

  // The chain only spans ±9% of spot, so probSum < 1; normalize the mean and
  // variance to the visible mass so both stay inside the observed range.
  const mean =
    probSum > 0 ? meanNum / probSum : (bars[0]!.lo + bars[bars.length - 1]!.hi) / 2;
  let varNum = 0;
  for (const b of bars) varNum += (b.mid - mean) ** 2 * b.prob;
  const variance = probSum > 0 ? varNum / probSum : 0;
  const std = Math.sqrt(Math.max(0, variance));
  const maxDensity = bars.reduce((m, b) => (b.density > m ? b.density : m), 0);

  return {
    bars,
    minK: sorted[0]!.strike,
    maxK: sorted[sorted.length - 1]!.strike,
    maxDensity,
    mean,
    std,
  };
}
