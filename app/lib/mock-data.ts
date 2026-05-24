/**
 * Mock data layer.
 *
 * The IDL is still being authored by the smart-contract agent in parallel.
 * Per CODING_PRD §8 Phase 3 contract: "every page renders without runtime
 * error against a mock data layer (lib/mock-data.ts)". This file is that.
 *
 * When the IDL lands, `lib/markets-client.ts` will swap these deterministic
 * generators for real RPC reads. The shape returned here mirrors §16's
 * per-page field map and `@meridian/types`'s `Market` / `Order` interfaces.
 *
 * Everything is deterministic per-ticker so the UI is stable across reloads,
 * which makes screenshots / verifier-prd-compliance reproducible.
 */

import type { Market, Order, OrderBookSnapshot, Side } from "@meridian/types";
import { MAG7_TICKERS, type Ticker } from "./tickers";

/** Per-ticker deterministic seed price in cents (e.g. AAPL ≈ $220.50 → 22050). */
const SEED_PRICES: Record<Ticker, number> = {
  AAPL: 22050,
  MSFT: 41800,
  GOOGL: 17320,
  AMZN: 21500,
  NVDA: 13550,
  META: 58900,
  TSLA: 28400,
};

/** Round to nearest $10 (PRD §2.3 strike algorithm). */
function roundTo10Dollars(cents: number): number {
  return Math.round(cents / 1000) * 1000;
}

/** Deterministic strike chain at ±3/6/9% (PRD §2.3). */
export function strikesForTicker(ticker: Ticker): number[] {
  const spot = SEED_PRICES[ticker];
  const offsets = [-0.09, -0.06, -0.03, 0, 0.03, 0.06, 0.09];
  const unique = new Set<number>();
  for (const off of offsets) {
    unique.add(roundTo10Dollars(Math.round(spot * (1 + off))));
  }
  return [...unique].sort((a, b) => a - b);
}

/** Spot price in cents (mock; in prod read from Pyth). */
export function spotForTicker(ticker: Ticker): number {
  return SEED_PRICES[ticker];
}

/** 24-hour mock price change percent (deterministic per ticker). */
export function changePctForTicker(ticker: Ticker): number {
  const seed = SEED_PRICES[ticker];
  // pseudo-randomize on the price — stable per ticker
  const x = ((seed * 9301 + 49297) % 233280) / 233280;
  return (x - 0.5) * 4; // -2% .. +2%
}

/** ATM strike for a ticker (closest to spot). */
export function atmStrike(ticker: Ticker): number {
  const spot = spotForTicker(ticker);
  const strikes = strikesForTicker(ticker);
  let best = strikes[0]!;
  let bestDist = Math.abs(spot - best);
  for (const s of strikes) {
    const d = Math.abs(spot - s);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Deterministic Yes-side fair price in cents for a (ticker, strike). */
export function yesPriceCents(ticker: Ticker, strike: number): number {
  const spot = spotForTicker(ticker);
  // very rough Black–Scholes-ish probability: 50 + slope * (spot - strike)
  const diffPct = ((spot - strike) / spot) * 100; // percent
  const raw = 50 + diffPct * 4; // ±2% spot = ±8c
  return Math.max(2, Math.min(98, Math.round(raw)));
}

/** Spread (in cents, both sides), deterministic. */
export function spreadCents(ticker: Ticker, strike: number): number {
  // Wider spread for ITM/OTM strikes, tight near ATM.
  const yes = yesPriceCents(ticker, strike);
  const center = Math.abs(yes - 50);
  return 1 + Math.floor(center / 20); // 1–3 cents
}

/** Build a deterministic order book for a (ticker, strike). */
export function orderBookFor(
  ticker: Ticker,
  strike: number,
): OrderBookSnapshot {
  const mid = yesPriceCents(ticker, strike);
  const sp = spreadCents(ticker, strike);
  const bestBid = Math.max(1, mid - sp);
  const bestAsk = Math.min(99, mid + sp);

  const bids: Order[] = [];
  const asks: Order[] = [];

  // 5 bid levels descending
  for (let i = 0; i < 5; i++) {
    const price = bestBid - i;
    if (price < 1) break;
    bids.push({
      owner: `MM${i + 1}`.padEnd(6, "x"),
      side: "bid",
      price,
      size: 100 * (i + 1) + ((strike + i) % 73),
      timestampMs: Date.now() - i * 60_000,
    });
  }
  // 5 ask levels ascending
  for (let i = 0; i < 5; i++) {
    const price = bestAsk + i;
    if (price > 99) break;
    asks.push({
      owner: `MM${i + 6}`.padEnd(6, "x"),
      side: "ask",
      price,
      size: 80 * (i + 1) + ((strike - i) % 51),
      timestampMs: Date.now() - i * 75_000,
    });
  }

  return {
    market: marketPdaForStub(ticker, strike),
    bids,
    asks,
  };
}

/** Stand-in for the real market PDA. The IDL will produce real ones. */
export function marketPdaForStub(ticker: Ticker, strike: number): string {
  return `Mkt${ticker}${strike}`.padEnd(43, "1");
}

/** Today at 4 PM ET as a unix-seconds expiry. */
export function todaysExpiryTs(): number {
  const now = new Date();
  const fourPmUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0, 0),
  );
  return Math.floor(fourPmUtc.getTime() / 1000);
}

/** Build a mock Market record for a (ticker, strike). */
export function mockMarket(ticker: Ticker, strike: number): Market {
  return {
    address: marketPdaForStub(ticker, strike),
    ticker,
    strike,
    expiryTs: todaysExpiryTs(),
    yesMint: `Yes${ticker}${strike}`.padEnd(43, "1"),
    noMint: `No${ticker}${strike}`.padEnd(43, "1"),
    vault: `Vlt${ticker}${strike}`.padEnd(43, "1"),
    oracle: `Pyth${ticker}`.padEnd(43, "1"),
    settled: false,
    outcome: null,
    settlementTs: null,
    settlementPrice: null,
    totalPairsMinted: 1200 + (strike % 800),
  };
}

/** Build all current markets — one per (ticker, strike) in the chain. */
export function allMockMarkets(): Market[] {
  const out: Market[] = [];
  for (const t of MAG7_TICKERS) {
    for (const s of strikesForTicker(t)) {
      out.push(mockMarket(t, s));
    }
  }
  return out;
}

/** Recent trades tape for a (ticker, strike). */
export interface RecentTrade {
  ts: number;
  price: number;
  size: number;
  side: Side;
  txSig: string;
}

export function mockRecentTrades(
  ticker: Ticker,
  strike: number,
  count = 20,
): RecentTrade[] {
  const mid = yesPriceCents(ticker, strike);
  const out: RecentTrade[] = [];
  for (let i = 0; i < count; i++) {
    const drift = (i * 7) % 5 - 2;
    out.push({
      ts: Date.now() - i * 40_000,
      price: Math.max(1, Math.min(99, mid + drift)),
      size: 25 + ((strike + i * 13) % 80),
      side: i % 2 === 0 ? "yes" : "no",
      txSig: `mock${i}${ticker}${strike}`.padEnd(88, "0"),
    });
  }
  return out;
}

/** Stubbed position (held quantity per side per market). */
export interface MockPosition {
  market: Market;
  side: Side;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
}

/** Stubbed trade-history event. */
export interface HistoryEvent {
  ts: number;
  type: "buy" | "sell" | "mint_pair" | "redeem_pair" | "redeem" | "settle";
  ticker: Ticker;
  strike: number;
  side: Side | null;
  quantity: number;
  price: number; // cents
  feeCents: number;
  status: "filled" | "cancelled" | "failed";
  txSig: string;
}
