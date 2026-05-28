/**
 * Pure (React-free) redirect-target selection for `/trade/[ticker]`.
 *
 * Extracted so the after-hours redirect logic is unit-testable without React /
 * Next. The page calls this once loading has settled and routes accordingly.
 *
 * Decision (Polymarket-style read-only after the close):
 *   1. If there are ACTIVE (non-settled) strikes, open the at-the-money active
 *      strike — the normal tradeable path.
 *   2. Else if there are SETTLED strikes (today's 0DTE markets after 4 PM ET),
 *      open the at-the-money SETTLED strike so it still opens (read-only, with
 *      the resolved outcome + redeem CTA) instead of hanging on "Loading…".
 *   3. Else return null — the caller routes to `/markets`.
 *
 * "At-the-money" = strike closest to `spotCents` (oracle spot in cents). When
 * spot is unknown (null), we fall back to the first strike in the list so we
 * still pick a real strike rather than spinning forever.
 */

/** Closest strike to `spotCents`; first strike when spot is unknown; null when empty. */
function atmStrike(strikes: number[], spotCents: number | null): number | null {
  if (strikes.length === 0) return null;
  if (spotCents == null) return strikes[0]!;
  let best = strikes[0]!;
  let bestDist = Math.abs(spotCents - best);
  for (const s of strikes) {
    const d = Math.abs(spotCents - s);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Pick the strike `/trade/[ticker]` should redirect to.
 *
 * @param activeStrikes  Non-settled (tradeable) strike values in cents.
 * @param settledStrikes Settled (resolved, read-only) strike values in cents.
 * @param spotCents      Oracle spot in cents, or null when unavailable.
 * @returns The ATM strike to open, or null when there is nothing to open
 *          (caller should route to `/markets`).
 */
export function pickRedirectStrike(
  activeStrikes: number[],
  settledStrikes: number[],
  spotCents: number | null,
): number | null {
  const active = atmStrike(activeStrikes, spotCents);
  if (active != null) return active;
  const settled = atmStrike(settledStrikes, spotCents);
  if (settled != null) return settled;
  return null;
}
