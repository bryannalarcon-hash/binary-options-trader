/**
 * Pure helper for post-settlement redemption amounts.
 *
 * The on-chain `redeem` reverts with NotEnoughBalance (0x177e) if the requested
 * amount exceeds the held balance. Two things caused that in practice:
 *   1. The builder re-resolved the market by (ticker, strike) — AMBIGUOUS when
 *      the same strike has settled markets across multiple expiry days — and hit
 *      the wrong market's mints. (Fixed by redeeming the exact market PDA.)
 *   2. A stale cached `quantity` (already redeemed / balance moved).
 *
 * `planRedeemAmount` clamps the request to what's actually held so redeem never
 * over-asks: it redeems exactly `min(requested, held)`, and 0 means "skip".
 * React/Next-free so it's unit-testable.
 */
export function planRedeemAmount(requestedQty: number, heldBalance: number): number {
  const q = Math.floor(Number.isFinite(requestedQty) ? requestedQty : 0);
  const h = Math.floor(Number.isFinite(heldBalance) ? heldBalance : 0);
  if (q <= 0 || h <= 0) return 0;
  return Math.min(q, h);
}
