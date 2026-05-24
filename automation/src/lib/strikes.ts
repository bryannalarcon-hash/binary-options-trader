/**
 * Strike-grid arithmetic. Mirror of PRD §2.3.
 *
 * Strike convention (matches Rust contract):
 *   - All on-chain prices are integer USD CENTS.
 *   - Strike grid step is $10 → 1000 cents.
 *   - Steps are ±3%, ±6%, ±9% off the previous close.
 */

export const STRIKE_PERCENTAGES = [-9, -6, -3, 3, 6, 9] as const;

/** Strike step in cents ($10 = 1000 cents). */
export const STRIKE_STEP_CENTS = 1000;

/** Round to nearest multiple of `step`, ties away from zero. */
function roundToStep(valueCents: number, step: number): number {
  const sign = valueCents >= 0 ? 1 : -1;
  const abs = Math.abs(valueCents);
  return sign * Math.round(abs / step) * step;
}

/**
 * Compute the strike grid for one stock.
 *
 * @param previousCloseCents Previous-day close in USD cents (e.g. 22000 = $220.00).
 * @returns Sorted, deduplicated list of strikes in cents.
 */
export function computeStrikes(previousCloseCents: number): number[] {
  if (!Number.isFinite(previousCloseCents) || previousCloseCents <= 0) {
    throw new Error(
      `computeStrikes: invalid previous close ${previousCloseCents}`,
    );
  }

  const strikes = new Set<number>();
  for (const pct of STRIKE_PERCENTAGES) {
    const raw = previousCloseCents * (1 + pct / 100);
    const rounded = roundToStep(raw, STRIKE_STEP_CENTS);
    if (rounded > 0) strikes.add(rounded);
  }

  return Array.from(strikes).sort((a, b) => a - b);
}
