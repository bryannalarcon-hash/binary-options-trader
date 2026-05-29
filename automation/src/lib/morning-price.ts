/**
 * Reference-price helpers for the morning market-creation job.
 *
 * Background: the job used to read the previous close ONLY from Pyth Hermes.
 * When Hermes throttled (HTTP 503s on 2026-05-28/29) it returned no price, the
 * job skipped every ticker, created zero markets — yet still reported "ok".
 * The on-chain `OracleAccount` already holds the last pushed price, so we fall
 * back to it and keep creating markets through a Hermes outage.
 */

/**
 * Convert an on-chain `OracleAccount` (`price: i64`, `expo: i32`, Pyth
 * convention `actual = price * 10^expo`) to a USD number.
 * e.g. price=31146, expo=-2 → 311.46.
 */
export function oraclePriceToUsd(price: number, expo: number): number {
  return price * Math.pow(10, expo);
}

/**
 * Resolve the reference "previous close" in USD: prefer the Hermes price, fall
 * back to the on-chain oracle, and return `null` only when neither is a usable
 * positive number. A `null` result means the ticker genuinely can't be priced
 * (and the run must NOT be reported as a healthy success if every ticker is null).
 */
export function resolvePreviousCloseUsd(
  hermesUsd: number | null | undefined,
  oracleUsd: number | null | undefined,
): number | null {
  if (typeof hermesUsd === "number" && Number.isFinite(hermesUsd) && hermesUsd > 0) {
    return hermesUsd;
  }
  if (typeof oracleUsd === "number" && Number.isFinite(oracleUsd) && oracleUsd > 0) {
    return oracleUsd;
  }
  return null;
}
