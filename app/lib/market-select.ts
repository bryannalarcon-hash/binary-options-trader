// market-select.ts — pure selector for resolving ONE market account from a
// (ticker, strike) pair when multiple expiry days share the same strike.
// Used by useMarket / findOrderBookPda / useHoldingForMarket so the trade page,
// order book, trades feed, and holdings all bind to the SAME market: prefer the
// non-settled (live or awaiting-crank) market, tie-break by latest expiryTs.
// Mirrors the strike-list rule in markets-client.ts (latest non-settled per strike).

export interface SelectableMarket {
  ticker: string;
  strike: number;
  expiryTs: number;
  settled: boolean;
}

/**
 * Pick the canonical market for `ticker` + `strike` from `markets`.
 *
 * Strikes recur across expiry days (e.g. AAPL $320 on May 27 AND today), so a
 * naive `.find()` returns whichever account the RPC happened to list first —
 * often a long-settled one. Selection rule:
 *   1. A non-settled market beats a settled one (live trading > resolved banner).
 *   2. Among equals, the latest expiryTs wins (today over an unsettled straggler).
 * Returns null when no market matches at all.
 */
export function pickMarketForStrike<T extends SelectableMarket>(
  markets: readonly T[],
  ticker: string,
  strike: number,
): T | null {
  let best: T | null = null;
  for (const m of markets) {
    if (m.ticker !== ticker || m.strike !== strike) continue;
    if (best === null) {
      best = m;
      continue;
    }
    if (m.settled !== best.settled) {
      if (!m.settled) best = m; // non-settled beats settled
      continue;
    }
    if (m.expiryTs > best.expiryTs) best = m; // latest expiry wins
  }
  return best;
}
