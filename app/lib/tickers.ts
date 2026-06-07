// tickers.ts — static MAG7 ticker metadata (names, Pyth feed ids) plus the
// TEST-market ("-T" suffix, e.g. "AAPL-T") helpers: detection, base-ticker
// stripping, and display names that clearly label fixtures as "(Test)".

import type { Ticker } from "@meridian/types";

/**
 * MAG7 tickers — duplicated here as a const tuple so Next.js can statically
 * import this list without crossing the `@meridian/types` CJS boundary
 * (the CJS named export was getting lost in webpack's tree-shake pass).
 */
export const MAG7_TICKERS: readonly Ticker[] = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
] as const;

/** Display name for each MAG7 ticker (for cards / nav). */
export const TICKER_NAME: Record<Ticker, string> = {
  AAPL: "Apple",
  MSFT: "Microsoft",
  GOOGL: "Alphabet",
  AMZN: "Amazon",
  NVDA: "NVIDIA",
  META: "Meta Platforms",
  TSLA: "Tesla",
};

/**
 * Pyth devnet feed IDs for each MAG7 ticker.
 * (Pulled from .env — present here as compile-time constants for the UI.)
 * On localnet we ignore these and use the mock-oracle PDA per ticker.
 */
export const PYTH_FEED_ID: Record<Ticker, string> = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  AMZN: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

// ---------------------------------------------------------------------------
// TEST markets — a ticker ending in "-T" (e.g. "AAPL-T") is a permanently-
// tradeable FIXTURE mirroring the real stock. It must always be labeled as
// fake in the UI (see `.test-badge` + `displayTickerName`).
// ---------------------------------------------------------------------------

/** On-chain ticker suffix that marks a TEST market fixture. */
export const TEST_TICKER_SUFFIX = "-T";

/** True when an on-chain ticker names a TEST market (e.g. "AAPL-T"). */
export function isTestTicker(t: string): boolean {
  return t.length > TEST_TICKER_SUFFIX.length && t.endsWith(TEST_TICKER_SUFFIX);
}

/** Strip the TEST suffix ("AAPL-T" → "AAPL"); no-op for real tickers. */
export function baseTicker(t: string): string {
  return isTestTicker(t) ? t.slice(0, -TEST_TICKER_SUFFIX.length) : t;
}

/**
 * Human display name for any on-chain ticker string.
 *   - Test ticker:  mirrored company name + " (Test)"  ("AAPL-T" → "Apple (Test)")
 *   - Real ticker:  TICKER_NAME entry, or the raw ticker when unknown.
 */
export function displayTickerName(t: string): string {
  const names = TICKER_NAME as Record<string, string>;
  if (isTestTicker(t)) {
    const base = baseTicker(t);
    return `${names[base] ?? base} (Test)`;
  }
  return names[t] ?? t;
}

export type { Ticker };
