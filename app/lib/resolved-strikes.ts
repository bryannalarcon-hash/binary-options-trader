/**
 * Pure helpers for the after-hours "resolved" (read-only) strike view.
 *
 * After the 0DTE close, settled markets from MULTIPLE past trading days
 * accumulate on-chain (each day is a distinct expiry with its own ±3/6/9%
 * grid). The resolved view must show only the MOST RECENT settled day's grid
 * (~6 strikes) — not the entire settled history (which piles up 6 strikes per
 * past day, e.g. 18 across three days). De-duping by strike VALUE is wrong
 * because each day's grid has different strike values.
 *
 * React/Next-free so it's unit-testable in isolation (tests/unit).
 */

/** Split an array into consecutive chunks of at most `size` (size >= 1). */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** The newest expiry among SETTLED markets, or null if none are settled. */
export function latestSettledExpiry<T extends { settled: boolean; expiryTs: number }>(
  markets: readonly T[],
): number | null {
  let max: number | null = null;
  for (const m of markets) {
    if (m.settled && (max === null || m.expiryTs > max)) max = m.expiryTs;
  }
  return max;
}

/**
 * The settled markets belonging to the single most-recent settled expiry,
 * de-duped by strike (defensive — normally one market per strike per expiry).
 * Returns [] when nothing is settled. Non-settled markets are ignored.
 */
export function pickLatestSettledMarkets<
  T extends { settled: boolean; expiryTs: number; strike: number },
>(markets: readonly T[]): T[] {
  const expiry = latestSettledExpiry(markets);
  if (expiry === null) return [];
  const byStrike = new Map<number, T>();
  for (const m of markets) {
    if (m.settled && m.expiryTs === expiry && !byStrike.has(m.strike)) {
      byStrike.set(m.strike, m);
    }
  }
  return [...byStrike.values()];
}
