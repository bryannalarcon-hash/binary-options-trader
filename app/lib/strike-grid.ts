/**
 * Canonical strike-grid arithmetic (app-side mirror of
 * `automation/src/lib/strikes.ts`).
 *
 * The morning job creates exactly the ±3/6/9% (rounded to $10) ladder per ticker
 * per day. On-chain markets are permanent PDAs, so if a ticker's markets get
 * re-created at a drifted reference (e.g. a dev re-seed run minutes apart), the
 * strike set can grow past the canonical 6 with off-grid duplicates. This module
 * lets the UI collapse such a set back to the intended ladder — but only when an
 * over-full set is actually present, so it's a no-op in normal operation.
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
 * The canonical strike ladder (in cents) for a reference price (cents), i.e. the
 * ±3/6/9% steps rounded to $10, deduped and sorted. Returns `[]` for an invalid
 * reference.
 */
export function expectedStrikeCents(referenceCents: number): number[] {
  if (!Number.isFinite(referenceCents) || referenceCents <= 0) return [];
  const strikes = new Set<number>();
  for (const pct of STRIKE_PERCENTAGES) {
    const rounded = roundToStep(referenceCents * (1 + pct / 100), STRIKE_STEP_CENTS);
    if (rounded > 0) strikes.add(rounded);
  }
  return Array.from(strikes).sort((a, b) => a - b);
}

/**
 * Given the distinct on-chain strikes for one ticker and a reference price,
 * return the set of strikes to KEEP — but ONLY when the on-chain set is larger
 * than the canonical grid (off-grid duplicates present). Returns `null` to mean
 * "keep everything" when:
 *   - the reference is unknown (can't compute the grid), or
 *   - the strike count is already within the grid (normal operation).
 *
 * Callers filter their rows through the returned Set when it is non-null.
 */
export function canonicalStrikeSet(
  strikesCents: number[],
  referenceCents: number | null,
): Set<number> | null {
  if (referenceCents == null) return null;
  const grid = expectedStrikeCents(referenceCents);
  if (grid.length === 0) return null;
  const distinct = new Set(strikesCents);
  if (distinct.size <= grid.length) return null; // within expectation → keep all
  return new Set(grid);
}
