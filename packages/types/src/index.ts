/**
 * @meridian/types — shared TypeScript types across app, automation, and tests.
 *
 * Keep these strictly POJO / discriminated-union shapes. Do NOT import
 * `@solana/web3.js` or `@coral-xyz/anchor` here — this package must stay
 * runtime-free so it can be consumed by both browser and node code.
 */

// =============================================================================
// Domain primitives
// =============================================================================

/** A MAG7 ticker symbol — exact set covered by Meridian v1. */
export type Ticker =
  | "AAPL"
  | "MSFT"
  | "GOOGL"
  | "AMZN"
  | "NVDA"
  | "META"
  | "TSLA";

export const MAG7_TICKERS: readonly Ticker[] = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
] as const;

/**
 * Token side — which of the two binary outcomes a position represents.
 * `yes` pays $1 if underlying closes >= strike; `no` is the inverse.
 */
export type Side = "yes" | "no";

/** Order-book side. */
export type OrderSide = "bid" | "ask";

/** Order type at placement time. */
export type OrderType = "market" | "limit";

/** Settlement outcome for a market. */
export type Outcome = "yes" | "no";

// =============================================================================
// Market / order shapes (lightweight UI/runtime mirrors of on-chain state)
// =============================================================================

export interface Market {
  /** Market PDA pubkey as base58 string. */
  address: string;
  ticker: Ticker;
  /** Strike in USD cents (e.g. 22000 = $220.00). */
  strike: number;
  /** Unix timestamp (seconds) when the market expires. */
  expiryTs: number;
  yesMint: string;
  noMint: string;
  vault: string;
  oracle: string;
  settled: boolean;
  outcome: Outcome | null;
  settlementTs: number | null;
  settlementPrice: number | null;
  totalPairsMinted: number;
}

export interface Order {
  /** Owner pubkey base58. */
  owner: string;
  side: OrderSide;
  /** Price in cents on the $1 scale (1..=99). */
  price: number;
  /** Size in YES tokens. */
  size: number;
  /** Wall-clock timestamp when placed. */
  timestampMs: number;
}

export interface OrderBookSnapshot {
  market: string;
  bids: Order[];
  asks: Order[];
}

// =============================================================================
// Helpers
// =============================================================================

/** Convert cents → "$x.xx" display string. */
export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Convert a YES price in cents (1..=99) to implied probability percent. */
export function impliedProbabilityPct(yesPriceCents: number): number {
  return yesPriceCents;
}
