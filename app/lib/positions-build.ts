/**
 * Pure assembly of portfolio positions from already-fetched balances.
 *
 * Kept separate from `positions-client.ts` (a "use client" hook module) so it's
 * unit-testable without pulling React/wallet-adapter into the test runner. All
 * imports here are TYPE-ONLY (erased at transpile), so this module has no
 * runtime deps.
 */
import type { Market, Side } from "@meridian/types";

export interface BuiltPosition {
  market: Market;
  side: Side;
  quantity: number;
  entryPrice: number | null;
  currentPrice: number | null;
}

/**
 * Build active + settled positions from real on-chain balances.
 *
 *  - `balances`     mint(base58) → token amount (0 when the ATA is absent).
 *  - `basis`        `${marketAddress}|${side}` → volume-weighted cost in cents.
 *  - `midByMarket`  marketAddress → YES book mid in cents (ACTIVE markets only).
 *
 * A SETTLED market's `currentPrice` is always null — its value is the resolved
 * $1/$0 outcome, not a live book mid, so we never fetch (or invent) a mid for it.
 * Markets with no balance on either side are skipped. Nothing is synthesized.
 */
export function buildPositions(
  markets: readonly Market[],
  balances: Map<string, number>,
  basis: Map<string, { avgCents: number }>,
  midByMarket: Map<string, number | null>,
): { active: BuiltPosition[]; settled: BuiltPosition[] } {
  const active: BuiltPosition[] = [];
  const settled: BuiltPosition[] = [];

  for (const m of markets) {
    const yesBal = balances.get(m.yesMint) ?? 0;
    const noBal = balances.get(m.noMint) ?? 0;
    if (yesBal <= 0 && noBal <= 0) continue;

    const mid = m.settled ? null : midByMarket.get(m.address) ?? null;
    const yesCurrent = mid;
    const noCurrent = mid != null ? 100 - mid : null;

    if (yesBal > 0) {
      const b = basis.get(`${m.address}|yes`);
      (m.settled ? settled : active).push({
        market: m,
        side: "yes",
        quantity: yesBal,
        entryPrice: b ? b.avgCents : null,
        currentPrice: yesCurrent,
      });
    }
    if (noBal > 0) {
      const b = basis.get(`${m.address}|no`);
      (m.settled ? settled : active).push({
        market: m,
        side: "no",
        quantity: noBal,
        entryPrice: b ? b.avgCents : null,
        currentPrice: noCurrent,
      });
    }
  }

  return { active, settled };
}
