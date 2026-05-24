/**
 * Markets data client.
 *
 * `useAllMarkets` first tries an on-chain `program.account.market.all()`
 * call. If the program isn't deployed at the configured ID (or the RPC is
 * unreachable, or the query throws for any other reason) we fall back to the
 * deterministic mock data so the UI keeps rendering without disruption.
 *
 * `useOrderBook` reads the on-chain `OrderBook` PDA via
 * `program.account.orderBook.fetch()` (zero-copy bytemuck layout, but Anchor
 * 0.30 deserializes it for us based on the IDL). It also subscribes to the
 * account via `connection.onAccountChange` for live updates.
 *
 * `useRecentTrades` subscribes to the `OrderMatched` program event and keeps
 * the last 50 matches in memory.
 *
 * All hooks gracefully fall back to deterministic mock data when:
 *   - the program isn't configured / deployed,
 *   - the read throws,
 *   - or (for OrderBook) the book PDA doesn't exist yet (newer market).
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { AnchorProvider, Program, type Idl, BN, EventParser, BorshCoder } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  Transaction,
  type VersionedTransaction,
  type Logs,
} from "@solana/web3.js";

import type { Market, Order, OrderBookSnapshot, Outcome, Ticker as TypesTicker } from "@meridian/types";
import { env } from "./env";
import idl from "./meridian-idl.json";
import {
  allMockMarkets,
  mockMarket,
  mockRecentTrades,
  orderBookFor,
  strikesForTicker,
  yesPriceCents,
  type RecentTrade,
} from "./mock-data";
import { MAG7_TICKERS, type Ticker } from "./tickers";

const MAG7_SET = new Set<string>(MAG7_TICKERS);
const ORDERBOOK_SEED = Buffer.from("orderbook");
const MARKET_SEED = Buffer.from("market");

function makeReadOnlyProgram(connection: ReturnType<typeof useConnection>["connection"]):
  | { program: Program; programId: PublicKey }
  | null
{
  if (!env.programId) return null;
  let programId: PublicKey;
  try {
    programId = new PublicKey(env.programId);
  } catch {
    return null;
  }
  // Read-only — minimal "Wallet" shim (we never `.rpc()` from this hook).
  const dummyKp = Keypair.generate();
  const dummyWallet = {
    publicKey: dummyKp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
    payer: dummyKp,
  };
  const provider = new AnchorProvider(connection, dummyWallet as any, {
    commitment: "confirmed",
  });
  const idlAny = idl as Idl & { address?: string };
  idlAny.address = programId.toBase58();
  const program = new Program(idlAny, provider);
  return { program, programId };
}

function bnToNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as BN).toString === "function") return Number((v as BN).toString());
  return Number(v);
}

function decodeOnChainMarket(entry: {
  publicKey: PublicKey;
  account: Record<string, unknown>;
}): Market | null {
  const a = entry.account as {
    ticker: string;
    strike: BN;
    expiryTs: BN;
    yesMint: PublicKey;
    noMint: PublicKey;
    vault: PublicKey;
    oracle: PublicKey;
    settled: boolean;
    outcome?: { yes?: object; no?: object } | null;
    settlementTs?: BN | null;
    settlementPrice?: BN | null;
    totalPairsMinted: BN;
  };
  if (!a.ticker || !MAG7_SET.has(a.ticker)) return null;
  let outcome: Outcome | null = null;
  if (a.outcome) {
    if ("yes" in a.outcome) outcome = "yes";
    else if ("no" in a.outcome) outcome = "no";
  }
  return {
    address: entry.publicKey.toBase58(),
    ticker: a.ticker as TypesTicker,
    strike: bnToNumber(a.strike),
    expiryTs: bnToNumber(a.expiryTs),
    yesMint: a.yesMint.toBase58(),
    noMint: a.noMint.toBase58(),
    vault: a.vault.toBase58(),
    oracle: a.oracle.toBase58(),
    settled: !!a.settled,
    outcome,
    settlementTs: a.settlementTs ? bnToNumber(a.settlementTs) : null,
    settlementPrice: a.settlementPrice ? bnToNumber(a.settlementPrice) : null,
    totalPairsMinted: bnToNumber(a.totalPairsMinted),
  };
}

/**
 * Hook: returns all live markets across the MAG7 chain.
 */
export function useAllMarkets(): { markets: Market[]; loading: boolean } {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<Market[]>(() => allMockMarkets());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (cancelled) return;
      const built = makeReadOnlyProgram(connection);
      if (!built) {
        if (!cancelled) {
          setMarkets(allMockMarkets());
          setLoading(false);
        }
        return;
      }
      try {
        const raw = (await (built.program.account as any).market.all()) as Array<{
          publicKey: PublicKey;
          account: Record<string, unknown>;
        }>;
        const decoded = raw
          .map((r) => decodeOnChainMarket(r))
          .filter((m): m is Market => m !== null);
        if (cancelled) return;
        if (decoded.length === 0) {
          setMarkets(allMockMarkets());
        } else {
          setMarkets(decoded);
        }
        setLoading(false);
      } catch {
        if (!cancelled) {
          setMarkets(allMockMarkets());
          setLoading(false);
        }
      }
    }

    void refresh();
    const id = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection]);

  return { markets, loading };
}

/** Hook: markets for one ticker. */
export function useMarketsForTicker(ticker: Ticker): {
  markets: Market[];
  loading: boolean;
} {
  const { markets, loading } = useAllMarkets();
  return {
    markets: markets.filter((m) => m.ticker === ticker),
    loading,
  };
}

/** Hook: a single market by (ticker, strike). */
export function useMarket(ticker: Ticker, strike: number): Market | null {
  const { markets } = useAllMarkets();
  return (
    markets.find((m) => m.ticker === ticker && m.strike === strike) ??
    mockMarket(ticker, strike)
  );
}

// ---------------------------------------------------------------------------
// Order-book + recent-trades — REAL on-chain reads with mock fallback.
// ---------------------------------------------------------------------------

/**
 * Locate the on-chain Market PDA + its derived OrderBook PDA for a
 * (ticker, strike). We don't know expiry_ts ahead of time so we scan
 * `program.account.market.all()` for a match. Returns null if not found.
 */
async function findOrderBookPda(
  program: Program,
  programId: PublicKey,
  ticker: Ticker,
  strike: number,
): Promise<{ market: PublicKey; orderbook: PublicKey } | null> {
  try {
    const all = (await (program.account as any).market.all()) as Array<{
      publicKey: PublicKey;
      account: { ticker: string; strike: BN };
    }>;
    const hit = all.find(
      (m) =>
        m.account.ticker === ticker &&
        Number(m.account.strike.toString()) === strike,
    );
    if (!hit) return null;
    const orderbook = PublicKey.findProgramAddressSync(
      [ORDERBOOK_SEED, hit.publicKey.toBuffer()],
      programId,
    )[0];
    return { market: hit.publicKey, orderbook };
  } catch {
    return null;
  }
}

/** Convert the on-chain bytemuck OrderBook into our UI snapshot shape. */
function decodeOrderBook(
  marketPk: PublicKey,
  raw: {
    bids: Array<{ owner: PublicKey; price: number; size: BN; timestamp: BN }>;
    asks: Array<{ owner: PublicKey; price: number; size: BN; timestamp: BN }>;
  },
): OrderBookSnapshot {
  const cleanBids: Order[] = [];
  const cleanAsks: Order[] = [];
  for (const b of raw.bids ?? []) {
    if (!b || b.owner.equals(PublicKey.default) || b.size.isZero()) continue;
    cleanBids.push({
      owner: b.owner.toBase58(),
      side: "bid",
      price: Number(b.price),
      size: Number(b.size.toString()),
      timestampMs: Number(b.timestamp.toString()) * 1000,
    });
  }
  for (const a of raw.asks ?? []) {
    if (!a || a.owner.equals(PublicKey.default) || a.size.isZero()) continue;
    cleanAsks.push({
      owner: a.owner.toBase58(),
      side: "ask",
      price: Number(a.price),
      size: Number(a.size.toString()),
      timestampMs: Number(a.timestamp.toString()) * 1000,
    });
  }
  // Highest bid first, lowest ask first (the UI sorts by price too).
  cleanBids.sort((x, y) => y.price - x.price);
  cleanAsks.sort((x, y) => x.price - y.price);
  return {
    market: marketPk.toBase58(),
    bids: cleanBids,
    asks: cleanAsks,
  };
}

/**
 * Hook: live order book for a (ticker, strike).
 *
 * - SSR hydrate: deterministic mock so cards don't flash empty.
 * - On mount: locate Market PDA → OrderBook PDA, fetch + subscribe.
 * - Falls back to mock book if program missing or fetch fails.
 */
export function useOrderBook(
  ticker: Ticker,
  strike: number,
): { book: OrderBookSnapshot | null; loading: boolean } {
  const { connection } = useConnection();
  const [book, setBook] = useState<OrderBookSnapshot | null>(() =>
    orderBookFor(ticker, strike),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;
    let orderbookPk: PublicKey | null = null;
    let marketPk: PublicKey | null = null;
    let program: Program | null = null;

    async function setup() {
      const built = makeReadOnlyProgram(connection);
      if (!built) {
        if (!cancelled) {
          setBook(orderBookFor(ticker, strike));
          setLoading(false);
        }
        return;
      }
      program = built.program;
      const located = await findOrderBookPda(
        built.program,
        built.programId,
        ticker,
        strike,
      );
      if (!located || cancelled) {
        if (!cancelled) {
          setBook(orderBookFor(ticker, strike));
          setLoading(false);
        }
        return;
      }
      marketPk = located.market;
      orderbookPk = located.orderbook;

      async function refresh() {
        if (cancelled || !program || !orderbookPk || !marketPk) return;
        try {
          const raw = await (program.account as any).orderBook.fetch(orderbookPk);
          if (cancelled) return;
          setBook(decodeOrderBook(marketPk, raw));
          setLoading(false);
        } catch {
          if (!cancelled) {
            // Account doesn't exist yet (init_market_books not called) — show
            // the deterministic mock book instead of an empty one.
            setBook(orderBookFor(ticker, strike));
            setLoading(false);
          }
        }
      }

      await refresh();
      // Live subscription: re-decode on every commit to the book account.
      try {
        subId = connection.onAccountChange(orderbookPk, () => {
          void refresh();
        }, "confirmed");
      } catch {
        // WS unavailable — fall back to slow poll.
      }
    }

    void setup();
    // Slow polling backstop (also catches cases where WS dropped).
    const id = window.setInterval(() => {
      if (orderbookPk && program) {
        void (async () => {
          try {
            const raw = await (program!.account as any).orderBook.fetch(orderbookPk!);
            if (!cancelled && marketPk) setBook(decodeOrderBook(marketPk, raw));
          } catch {
            /* keep last good book */
          }
        })();
      }
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (subId != null) {
        try {
          void connection.removeAccountChangeListener(subId);
        } catch {
          /* noop */
        }
      }
    };
  }, [connection, ticker, strike]);

  return { book, loading };
}

/**
 * Hook: recent trades tape for a (ticker, strike).
 *
 * Subscribes to program logs and parses `OrderMatched` events. Filters to
 * the matched market PDA. Keeps the last 50 matches in memory.
 *
 * Falls back to deterministic mock trades when program isn't deployed or
 * we can't find the market PDA.
 */
export function useRecentTrades(ticker: Ticker, strike: number): RecentTrade[] {
  const { connection } = useConnection();
  const [trades, setTrades] = useState<RecentTrade[]>(() =>
    mockRecentTrades(ticker, strike),
  );
  const tradesRef = useRef<RecentTrade[]>([]);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;
    let marketPk: PublicKey | null = null;
    let parser: EventParser | null = null;

    async function setup() {
      const built = makeReadOnlyProgram(connection);
      if (!built) {
        if (!cancelled) setTrades(mockRecentTrades(ticker, strike));
        return;
      }
      const located = await findOrderBookPda(
        built.program,
        built.programId,
        ticker,
        strike,
      );
      if (!located || cancelled) {
        if (!cancelled) setTrades(mockRecentTrades(ticker, strike));
        return;
      }
      marketPk = located.market;
      // Reset to empty list — we'll accumulate live matches.
      tradesRef.current = [];
      setTrades([]);

      parser = new EventParser(
        built.programId,
        new BorshCoder(built.program.idl as Idl),
      );

      try {
        subId = connection.onLogs(
          built.programId,
          (logs: Logs) => {
            if (cancelled || !parser || !marketPk) return;
            if (!logs.logs || logs.logs.length === 0) return;
            try {
              for (const ev of parser.parseLogs(logs.logs)) {
                if (ev.name !== "OrderMatched" && ev.name !== "orderMatched") continue;
                const data = ev.data as {
                  market: PublicKey;
                  price: number;
                  size: BN;
                  takerSide: number;
                };
                if (!data?.market || !data.market.equals(marketPk)) continue;
                const trade: RecentTrade = {
                  ts: Date.now(),
                  price: Number(data.price),
                  size: Number(data.size.toString()),
                  side: data.takerSide === 0 ? "yes" : "no",
                  txSig: logs.signature ?? "",
                };
                const next = [trade, ...tradesRef.current].slice(0, 50);
                tradesRef.current = next;
                setTrades(next);
              }
            } catch {
              /* parser errors are non-fatal */
            }
          },
          "confirmed",
        );
      } catch {
        // WS unavailable — keep mock data on screen.
        if (!cancelled) setTrades(mockRecentTrades(ticker, strike));
      }
    }

    void setup();

    return () => {
      cancelled = true;
      if (subId != null) {
        try {
          void connection.removeOnLogsListener(subId);
        } catch {
          /* noop */
        }
      }
    };
  }, [connection, ticker, strike]);

  return trades;
}

/**
 * Hook: strike list for a ticker, decorated with live yes/no prices for
 * the strike-list UI element on Trade page + per-card expander on Markets.
 */
export function useStrikeList(ticker: Ticker): {
  strike: number;
  yesCents: number;
  noCents: number;
  volume: number;
}[] {
  const build = (t: Ticker) =>
    strikesForTicker(t).map((s) => {
      const yes = yesPriceCents(t, s);
      return {
        strike: s,
        yesCents: yes,
        noCents: 100 - yes,
        volume: 1000 + ((s + t.length * 73) % 4500),
      };
    });

  const [out, setOut] = useState<
    { strike: number; yesCents: number; noCents: number; volume: number }[]
  >(() => build(ticker));

  useEffect(() => {
    function refresh() {
      setOut(build(ticker));
    }
    refresh();
    const id = window.setInterval(refresh, 2_500);
    return () => window.clearInterval(id);
  }, [ticker]);

  return out;
}
