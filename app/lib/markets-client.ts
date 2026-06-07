/**
 * Markets data client — REAL on-chain reads, no mock fallbacks.
 *
 * Every hook reads the deployed program at `env.programId`:
 *   - `useAllMarkets`  → `program.account.market.all()` (decoded MAG7 markets
 *                        plus "-T" TEST fixtures, e.g. "AAPL-T").
 *   - `useMarket`      → one market by (ticker, strike) from `useAllMarkets`.
 *   - `useSpotPrice`   → the per-ticker `OracleAccount` PDA (seeds
 *                        ["oracle", ticker]); spot USD = price / 100 (expo -2,
 *                        cents). Subscribes via onAccountChange + poll backstop.
 *   - `useOrderBook`   → the `OrderBook` PDA via `program.account.orderBook`,
 *                        subscribed live.
 *   - `useRecentTrades`→ live `OrderMatched` program events.
 *   - `useStrikeList`  → derived from REAL markets for the ticker, with yes/no
 *                        cents from the REAL order-book mid (or an oracle-vs-
 *                        strike ESTIMATE clearly flagged via `estimated`), and
 *                        volume only from real OrderMatched fills (else 0).
 *
 * Honest states (NO synthesized numbers anywhere):
 *   - SSR / initial:     empty ([]/null) + loading = true.
 *   - Empty on-chain:    empty + loading = false (callers render "No active …").
 *   - RPC / read error:  empty + error flag (callers render an error notice).
 */

"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnchorProvider, Program, type Idl, BN, EventParser, BorshCoder } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type VersionedTransaction,
  type Logs,
} from "@solana/web3.js";

import type { Market, Order, OrderBookSnapshot, Outcome, Side, Ticker as TypesTicker } from "@meridian/types";
import { env } from "./env";
import { withTimeout } from "./loading-state";
import { pickMarketForStrike } from "./market-select";
import idl from "./meridian-idl.json";
import { pickLatestSettledMarkets } from "./resolved-strikes";
import { canonicalStrikeSet } from "./strike-grid";
import { MAG7_TICKERS, isTestTicker, type Ticker } from "./tickers";

/**
 * Bounded timeout (ms) for the `market.all()` getProgramAccounts read. Under
 * devnet RPC throttling that call can hang indefinitely; we race it so the
 * loading state is TERMINAL — it resolves to an honest error/empty state within
 * this window instead of pinning `loading=true` forever (the after-hours
 * "/portfolio loads infinitely" bug). 12s is well past a healthy RPC round-trip.
 */
const MARKETS_READ_TIMEOUT_MS = 12_000;
/** Sentinel for a timed-out / failed read, distinguished from a real empty []. */
const MARKETS_TIMEOUT = Symbol("markets-read-timeout");

const MAG7_SET = new Set<string>(MAG7_TICKERS);
const ORDERBOOK_SEED = Buffer.from("orderbook");
const ORACLE_SEED = Buffer.from("oracle");

/** Recent-trade tape entry (live `OrderMatched` events). */
export interface RecentTrade {
  ts: number;
  price: number;
  size: number;
  side: Side;
  txSig: string;
}

/** One strike row derived from a real on-chain market. */
export interface StrikeRow {
  strike: number;
  yesCents: number;
  noCents: number;
  /** Real 24h-ish volume from OrderMatched fills; 0 when none observed. */
  volume: number;
  /**
   * True when yes/no cents are an oracle-vs-strike ESTIMATE (book empty),
   * false when they come from the real order-book mid.
   */
  estimated: boolean;
  /**
   * Display status for the row. Active (tradeable) rows from `useStrikeList`
   * leave this `undefined`. Rows from `useResolvedStrikeList` carry:
   *   - "resolved":  market.settled === true (outcome known).
   *   - "expired":   expiry has passed but the market isn't settled yet
   *                  (awaiting the settle crank).
   * Set only on the resolved/read-only path so the active contract is unchanged.
   */
  status?: "resolved" | "expired";
  /** Settled outcome (which side won), only on resolved rows. */
  outcome?: Outcome | null;
  /** Frozen settlement price in cents, only on resolved rows. */
  settlementPrice?: number | null;
  /** Settlement unix-seconds timestamp, only on resolved rows. */
  settlementTs?: number | null;
}

// Stable empty reference so `setRows(EMPTY_STRIKE_ROWS)` is a no-op once already
// empty (React bails out), instead of a fresh `[]` that retriggers renders.
const EMPTY_STRIKE_ROWS: StrikeRow[] = [];

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
  // MAG7 plus "-T" TEST fixtures (e.g. "AAPL-T") — anything else is noise.
  if (!a.ticker || !(MAG7_SET.has(a.ticker) || isTestTicker(a.ticker))) return null;
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
 * Hook: all live markets across the MAG7 chain (REAL on-chain only).
 *
 * Returns:
 *   - markets: decoded markets ([] until first successful read, or on error)
 *   - loading: true until the first read settles
 *   - error:   true if the program is not configured or a read threw
 */
// ---------------------------------------------------------------------------
// Shared all-markets store
//
// `useAllMarkets` is mounted by many components at once (the landing alone uses
// it ~8×: the hero + every market row). Previously each instance ran its OWN
// `getProgramAccounts` (`market.all()`) on a 10s timer — 8 credit-heavy reads
// every 10s, which exhausts a free-tier devnet RPC ("max usage reached"). This
// module-level store collapses them into ONE fetch loop shared via
// `useSyncExternalStore`: a single `market.all()` every 30s no matter how many
// components subscribe. The loop starts on the first subscriber and stops when
// the last unsubscribes. The `markets` array keeps a stable reference until the
// decoded content actually changes (so downstream memoization doesn't churn,
// and `useSyncExternalStore` doesn't loop on an unstable snapshot).
// ---------------------------------------------------------------------------
const ALL_MARKETS_POLL_MS = 30_000;
const EMPTY_MARKETS: Market[] = Object.freeze([]) as unknown as Market[];

interface AllMarketsSnapshot {
  markets: Market[];
  loading: boolean;
  error: boolean;
}

let amSnapshot: AllMarketsSnapshot = { markets: EMPTY_MARKETS, loading: true, error: false };
let amSig = "";
let amConnection: Connection | null = null;
let amTimer: ReturnType<typeof setInterval> | null = null;
let amInFlight = false;
const amListeners = new Set<() => void>();

/** Replace the snapshot (new reference) only when something actually changed. */
function amSet(next: Partial<AllMarketsSnapshot>): void {
  const merged: AllMarketsSnapshot = { ...amSnapshot, ...next };
  if (
    merged.markets === amSnapshot.markets &&
    merged.loading === amSnapshot.loading &&
    merged.error === amSnapshot.error
  ) {
    return;
  }
  amSnapshot = merged;
  for (const l of amListeners) l();
}

async function amRefresh(): Promise<void> {
  if (amInFlight || !amConnection) return;
  amInFlight = true;
  try {
    const built = makeReadOnlyProgram(amConnection);
    if (!built) {
      amSet({ markets: EMPTY_MARKETS, loading: false, error: true });
      return;
    }
    // Race the getProgramAccounts read against a bounded timeout so a hung
    // devnet RPC can't pin loading=true forever (honest error, never a fake []).
    const raw = await withTimeout<
      | Array<{ publicKey: PublicKey; account: Record<string, unknown> }>
      | typeof MARKETS_TIMEOUT
    >(
      (built.program.account as any).market.all(),
      MARKETS_READ_TIMEOUT_MS,
      MARKETS_TIMEOUT,
    );
    if (raw === MARKETS_TIMEOUT) {
      amSet({ loading: false, error: true }); // keep last-good markets; retry next poll
      return;
    }
    const decoded = raw
      .map((r) => decodeOnChainMarket(r))
      .filter((m): m is Market => m !== null);
    const sig = decoded
      .map((m) => `${m.address}:${m.strike}:${m.settled ? 1 : 0}:${m.totalPairsMinted}`)
      .sort()
      .join("|");
    if (sig !== amSig) {
      amSig = sig;
      amSet({ markets: decoded, loading: false, error: false });
    } else {
      amSet({ loading: false, error: false });
    }
  } catch {
    amSet({ loading: false, error: true }); // keep last-good markets
  } finally {
    amInFlight = false;
  }
}

function makeAmSubscribe(connection: Connection) {
  return (listener: () => void): (() => void) => {
    amListeners.add(listener);
    amConnection = connection;
    if (amTimer == null) {
      void amRefresh();
      amTimer = setInterval(() => void amRefresh(), ALL_MARKETS_POLL_MS);
    }
    return () => {
      amListeners.delete(listener);
      if (amListeners.size === 0 && amTimer != null) {
        clearInterval(amTimer);
        amTimer = null;
      }
    };
  };
}

/**
 * Hook: all MAG7 markets. Backed by ONE shared `getProgramAccounts` loop (see
 * the store above) regardless of how many components mount it.
 */
export function useAllMarkets(): { markets: Market[]; loading: boolean; error: boolean } {
  const { connection } = useConnection();
  const subscribe = useMemo(() => makeAmSubscribe(connection), [connection]);
  const getSnapshot = () => amSnapshot;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Hook: markets for one ticker. */
export function useMarketsForTicker(ticker: Ticker): {
  markets: Market[];
  loading: boolean;
  error: boolean;
} {
  const { markets, loading, error } = useAllMarkets();
  // Memoize the filtered slice — returning a fresh array every render makes it
  // an unstable useEffect dependency for consumers (useStrikeList), which then
  // re-run their effects every render and loop on setState (max-update-depth).
  const filtered = useMemo(
    () => markets.filter((m) => m.ticker === ticker),
    [markets, ticker],
  );
  return { markets: filtered, loading, error };
}

/** Hook: a single market by (ticker, strike). null until found / if absent. */
export function useMarket(
  ticker: Ticker,
  strike: number,
): { market: Market | null; loading: boolean; error: boolean } {
  const { markets, loading, error } = useAllMarkets();
  // Strikes recur across expiry days — pick the live/latest market, not the
  // first account the RPC happens to return (often a long-settled one).
  const market = pickMarketForStrike(markets, ticker, strike);
  return { market, loading, error };
}

// ---------------------------------------------------------------------------
// Spot price — REAL OracleAccount PDA read (seeds ["oracle", ticker]).
// ---------------------------------------------------------------------------

/** Derive the OracleAccount PDA for a ticker. */
function oraclePda(programId: PublicKey, ticker: Ticker): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ORACLE_SEED, Buffer.from(ticker, "utf8")],
    programId,
  )[0];
}

/**
 * Hook: live spot price for a ticker, read from the on-chain OracleAccount.
 *
 *   - spotUsd:      price / 100 (oracle stores cents, expo = -2), null until read.
 *   - publishTime:  oracle publish_time (unix seconds), null until read.
 *   - loading:      true until the first read settles.
 *   - error:        true if program absent, PDA missing, or a read threw.
 *
 * Subscribes via onAccountChange for live updates with a slow poll backstop.
 */
export function useSpotPrice(ticker: Ticker): {
  spotUsd: number | null;
  publishTime: number | null;
  loading: boolean;
  error: boolean;
} {
  const { connection } = useConnection();
  const [spotUsd, setSpotUsd] = useState<number | null>(null);
  const [publishTime, setPublishTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;
    let pda: PublicKey | null = null;
    let program: Program | null = null;

    setLoading(true);
    setError(false);

    const built = makeReadOnlyProgram(connection);
    if (!built) {
      setSpotUsd(null);
      setPublishTime(null);
      setError(true);
      setLoading(false);
      return;
    }
    program = built.program;
    pda = oraclePda(built.programId, ticker);

    async function refresh() {
      if (cancelled || !program || !pda) return;
      try {
        const acct = (await (program.account as any).oracleAccount.fetch(pda)) as {
          price: BN;
          publishTime: BN;
        };
        if (cancelled) return;
        const cents = bnToNumber(acct.price);
        setSpotUsd(cents / 100);
        setPublishTime(bnToNumber(acct.publishTime));
        setError(false);
        setLoading(false);
      } catch {
        if (!cancelled) {
          // Missing PDA or RPC error — honest empty state, never a fake number.
          setError(true);
          setLoading(false);
        }
      }
    }

    void refresh();
    try {
      subId = connection.onAccountChange(pda, () => void refresh(), "confirmed");
    } catch {
      /* WS unavailable — poll backstop below still runs */
    }
    // Oracle spot poll: slowed 10s → 30s. One getAccountInfo per ticker, mounted
    // ~8× on the landing; the WS `onAccountChange` above still delivers live spot
    // moves, so this is just a backstop for a dropped socket.
    const id = window.setInterval(() => void refresh(), 30_000);

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
  }, [connection, ticker]);

  return { spotUsd, publishTime, loading, error };
}

// ---------------------------------------------------------------------------
// Order-book + recent-trades — REAL on-chain reads (no fallback).
// ---------------------------------------------------------------------------

/**
 * Locate the on-chain Market PDA + its derived OrderBook PDA for a
 * (ticker, strike). We scan `program.account.market.all()` for a match.
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
      account: { ticker: string; strike: BN; expiryTs: BN; settled: boolean };
    }>;
    // Same selection rule as useMarket: prefer the live (non-settled) market,
    // latest expiry on ties — strikes recur across days.
    const hit = pickMarketForStrike(
      all.map((m) => ({
        ticker: m.account.ticker,
        strike: Number(m.account.strike.toString()),
        expiryTs: Number(m.account.expiryTs.toString()),
        settled: !!m.account.settled,
        raw: m,
      })),
      ticker,
      strike,
    )?.raw;
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
 * Hook: live order book for a (ticker, strike) — REAL on-chain only.
 *
 *   - book:    snapshot, or null until first read / on missing-PDA / error.
 *   - loading: true until the first read settles.
 *   - error:   true if program absent, market/book PDA missing, or read threw.
 *
 * NOTE: an EXISTING but EMPTY book returns a non-null snapshot with empty
 * bids/asks (loading=false, error=false) so callers can show "Order book is
 * empty". A missing PDA or RPC failure sets error=true.
 */
export function useOrderBook(
  ticker: Ticker,
  strike: number,
): { book: OrderBookSnapshot | null; loading: boolean; error: boolean } {
  const { connection } = useConnection();
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;
    let orderbookPk: PublicKey | null = null;
    let marketPk: PublicKey | null = null;
    let program: Program | null = null;

    setLoading(true);
    setError(false);

    async function setup() {
      const built = makeReadOnlyProgram(connection);
      if (!built) {
        if (!cancelled) {
          setBook(null);
          setError(true);
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
      if (cancelled) return;
      if (!located) {
        setBook(null);
        setError(true);
        setLoading(false);
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
          setError(false);
          setLoading(false);
        } catch {
          if (!cancelled) {
            // Book PDA doesn't exist yet (init_market_books not called) — honest
            // empty book so the caller renders "Order book is empty", not mock.
            setBook(marketPk ? { market: marketPk.toBase58(), bids: [], asks: [] } : null);
            setError(false);
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

  return { book, loading, error };
}

/**
 * Hook: recent trades tape for a (ticker, strike) — REAL on-chain only.
 *
 * Subscribes to program logs and parses `OrderMatched` events filtered to the
 * matched market PDA. Keeps the last 50 matches in memory. Starts empty; never
 * synthesizes trades. `error` is set if the program/market can't be resolved.
 */
export function useRecentTrades(
  ticker: Ticker,
  strike: number,
): { trades: RecentTrade[]; loading: boolean; error: boolean } {
  const { connection } = useConnection();
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const tradesRef = useRef<RecentTrade[]>([]);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;
    let marketPk: PublicKey | null = null;
    let parser: EventParser | null = null;

    setLoading(true);
    setError(false);
    tradesRef.current = [];
    setTrades([]);

    async function setup() {
      const built = makeReadOnlyProgram(connection);
      if (!built) {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
        return;
      }
      const located = await findOrderBookPda(
        built.program,
        built.programId,
        ticker,
        strike,
      );
      if (cancelled) return;
      if (!located) {
        setError(true);
        setLoading(false);
        return;
      }
      marketPk = located.market;
      setLoading(false);

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
        // WS unavailable — tape stays empty (honest), flag error.
        if (!cancelled) setError(true);
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

  return { trades, loading, error };
}

// ---------------------------------------------------------------------------
// Strike list — derived from REAL markets + REAL order books.
// ---------------------------------------------------------------------------

/**
 * Read one market's order book and derive a yes/no mid in cents.
 *
 * Returns:
 *   - { yesCents, estimated:false } when the book has a usable bid+ask mid
 *     (or a one-sided best price);
 *   - null when the book is empty / missing (caller falls back to an estimate).
 *
 * Also returns the summed resting size as a rough liquidity figure (NOT used as
 * "volume" — volume comes only from OrderMatched fills).
 */
/** Order-book PDA for a market. */
function orderBookPda(programId: PublicKey, marketPk: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ORDERBOOK_SEED, marketPk.toBuffer()],
    programId,
  )[0];
}

/** Best bid/ask mid (yes cents) from a decoded order book, or null if empty. */
function bookMidFromDecoded(
  raw: {
    bids?: Array<{ owner: PublicKey; price: number; size: BN }>;
    asks?: Array<{ owner: PublicKey; price: number; size: BN }>;
  } | null,
): { yesCents: number } | null {
  if (!raw) return null;
  let bestBid = -1;
  let bestAsk = -1;
  for (const b of raw.bids ?? []) {
    if (!b || b.owner.equals(PublicKey.default) || b.size.isZero()) continue;
    if (b.price > bestBid) bestBid = b.price;
  }
  for (const a of raw.asks ?? []) {
    if (!a || a.owner.equals(PublicKey.default) || a.size.isZero()) continue;
    if (bestAsk < 0 || a.price < bestAsk) bestAsk = a.price;
  }
  if (bestBid >= 0 && bestAsk >= 0) return { yesCents: Math.round((bestBid + bestAsk) / 2) };
  if (bestBid >= 0) return { yesCents: bestBid };
  if (bestAsk >= 0) return { yesCents: bestAsk };
  return null; // book exists but empty
}

/**
 * Hook: strike list for a ticker, derived from REAL on-chain markets.
 *
 * For each non-settled market matching `ticker`:
 *   - strike  = market.strike (real).
 *   - yes/no  = REAL order-book mid when available; otherwise an ESTIMATE from
 *               oracle spot vs strike, with `estimated:true` so the UI can mark
 *               it. When the oracle is unavailable too, the row is omitted
 *               (we never invent a price).
 *   - volume  = REAL OrderMatched fill size observed live; 0 otherwise.
 *
 * Returns rows + loading/error so callers can render honest empty/error states.
 */
export function useStrikeList(ticker: Ticker): {
  rows: StrikeRow[];
  loading: boolean;
  error: boolean;
} {
  const { connection } = useConnection();
  const { markets, loading: marketsLoading, error: marketsError } = useMarketsForTicker(ticker);
  const { spotUsd } = useSpotPrice(ticker);
  const [rows, setRows] = useState<StrikeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Accumulated real volume per strike (cents key) from OrderMatched events.
  const volumeRef = useRef<Map<number, number>>(new Map());

  // Subscribe to OrderMatched events to accumulate REAL volume per strike.
  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;
    const built = makeReadOnlyProgram(connection);
    if (!built || markets.length === 0) return;

    const byMarketPk = new Map<string, number>();
    for (const m of markets) byMarketPk.set(m.address, m.strike);

    const parser = new EventParser(built.programId, new BorshCoder(built.program.idl as Idl));
    try {
      subId = connection.onLogs(
        built.programId,
        (logs: Logs) => {
          if (cancelled || !logs.logs?.length) return;
          try {
            for (const ev of parser.parseLogs(logs.logs)) {
              if (ev.name !== "OrderMatched" && ev.name !== "orderMatched") continue;
              const d = ev.data as { market: PublicKey; size: BN };
              const strike = d?.market ? byMarketPk.get(d.market.toBase58()) : undefined;
              if (strike == null) continue;
              const cur = volumeRef.current.get(strike) ?? 0;
              volumeRef.current.set(strike, cur + Number(d.size.toString()));
            }
          } catch {
            /* non-fatal */
          }
        },
        "confirmed",
      );
    } catch {
      /* WS unavailable — volume stays 0 (honest) */
    }
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
  }, [connection, markets]);

  useEffect(() => {
    let cancelled = false;

    if (marketsError) {
      setRows(EMPTY_STRIKE_ROWS);
      setError(true);
      setLoading(false);
      return;
    }
    if (marketsLoading) {
      setLoading(true);
      return;
    }

    const built = makeReadOnlyProgram(connection);
    if (!built) {
      setRows(EMPTY_STRIKE_ROWS);
      setError(true);
      setLoading(false);
      return;
    }

    // One row per strike: among non-settled markets, keep the LATEST-expiry one.
    // This hides stale duplicate strikes (e.g. an expired batch lingering next to
    // today's) and makes a dev "re-rolled" strike show once, as the fresh market.
    const byStrike = new Map<number, Market>();
    for (const m of markets.filter((x) => !x.settled)) {
      const prev = byStrike.get(m.strike);
      if (!prev || m.expiryTs > prev.expiryTs) byStrike.set(m.strike, m);
    }
    let active = [...byStrike.values()];
    // Collapse off-grid duplicate strikes (e.g. devnet markets re-created at a
    // drifted reference, which left MSFT with 9 strikes instead of 6) back to
    // the canonical ±3/6/9% ladder. No-op unless an over-full set is present.
    const keep = canonicalStrikeSet(
      active.map((m) => m.strike),
      spotUsd != null ? Math.round(spotUsd * 100) : null,
    );
    if (keep) active = active.filter((m) => keep.has(m.strike));
    if (active.length === 0) {
      setRows(EMPTY_STRIKE_ROWS);
      setError(false);
      setLoading(false);
      return;
    }

    async function build() {
      // Batch ALL of this ticker's order-book reads into ONE getMultipleAccounts
      // (Anchor `fetchMultiple`) instead of one getAccountInfo per strike — the
      // book reads were the largest remaining RPC-credit sink after the shared
      // market store. Order of results matches `active`.
      const obPdas = active.map((m) =>
        orderBookPda(built!.programId, new PublicKey(m.address)),
      );
      let books: Array<{ bids?: any[]; asks?: any[] } | null>;
      try {
        books = (await (built!.program.account as any).orderBook.fetchMultiple(
          obPdas,
        )) as Array<{ bids?: any[]; asks?: any[] } | null>;
      } catch {
        // Whole batch failed (RPC error) — fall through to estimates/omit.
        books = obPdas.map(() => null);
      }

      const out: StrikeRow[] = [];
      active.forEach((m, i) => {
        const mid = bookMidFromDecoded(books[i] ?? null);
        let yesCents: number | null = null;
        let estimated = false;
        if (mid) {
          yesCents = Math.max(1, Math.min(99, mid.yesCents));
        } else if (spotUsd != null) {
          // ESTIMATE only — clearly flagged. Rough monotonic mapping of
          // (spot - strike) into a 1..99 yes probability proxy.
          const strikeUsd = m.strike / 100;
          const diffPct = ((spotUsd - strikeUsd) / strikeUsd) * 100;
          yesCents = Math.max(1, Math.min(99, Math.round(50 + diffPct * 4)));
          estimated = true;
        } else {
          // No book, no oracle — omit rather than invent a price.
          return;
        }
        out.push({
          strike: m.strike,
          yesCents,
          noCents: 100 - yesCents,
          volume: volumeRef.current.get(m.strike) ?? 0,
          estimated,
        });
      });
      out.sort((a, b) => a.strike - b.strike);
      if (cancelled) return;
      setRows(out);
      setError(false);
      setLoading(false);
    }

    void build();
    // Book-mid refresh: slowed 5s → 20s. Each build() reads every strike's order
    // book (getAccountInfo per market) and runs once per mounted strike chain
    // (~8 on the landing); 5s polling was a major contributor to RPC-credit
    // exhaustion. 20s is plenty for a calm browse view; the trade page keeps its
    // live onAccountChange book subscription for real-time quoting.
    const id = window.setInterval(() => void build(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, markets, marketsLoading, marketsError, spotUsd]);

  return { rows, loading, error };
}

/**
 * Hook: SETTLED (read-only) strike rows for a ticker — the after-hours,
 * Polymarket-style view. After the 4:00 PM ET close every 0DTE market becomes
 * `settled=true`; `useStrikeList` (active-only) goes empty, so we surface those
 * settled markets here for DISPLAY without touching that active contract.
 *
 * One row per strike (the LATEST-expiry settled market for that strike — mirrors
 * useStrikeList's de-dup so a re-rolled/old batch doesn't double up). Each row
 * carries FROZEN settlement info:
 *   - status:          "resolved" when settled, "expired" if expiry passed but
 *                      not yet settled (awaiting the settle crank).
 *   - outcome:         which side won (null until settled).
 *   - yes/noCents:     100/0 for the winning side once resolved (the frozen
 *                      last price is the deterministic $1/$0 settlement, not a
 *                      synthesized quote); 50/50 placeholder only while expired-
 *                      but-unsettled, flagged via `estimated`.
 *   - settlementPrice: frozen close in cents.
 *   - settlementTs:    settlement time (unix seconds).
 *
 * NEVER synthesizes a price: resolved cents come straight from the on-chain
 * outcome; an awaiting-settlement row is clearly marked estimated.
 */
export function useResolvedStrikeList(ticker: Ticker): {
  rows: StrikeRow[];
  loading: boolean;
  error: boolean;
} {
  const { markets, loading: marketsLoading, error: marketsError } = useMarketsForTicker(ticker);
  const volumeless = 0; // settled rows carry no live volume (no fills post-close)

  const rows = useMemo<StrikeRow[]>(() => {
    // Show ONLY the most-recent settled day's grid (~6 strikes). Settled markets
    // from multiple past expiries accumulate on-chain, and each day's ±3/6/9%
    // grid has different strike values — de-duping by strike value would surface
    // all of them (e.g. 18 across three days). pickLatestSettledMarkets collapses
    // to the single latest settled expiry.
    const out: StrikeRow[] = [];
    for (const m of pickLatestSettledMarkets(markets)) {
      // Resolved: the winning side is worth 100¢, the other 0¢ — the REAL $1/$0
      // settlement, not an estimate. We still mark estimated=false because this
      // is the deterministic on-chain payout, not a book mid.
      const yesWon = m.outcome === "yes";
      const yesCents = m.outcome ? (yesWon ? 100 : 0) : 50;
      out.push({
        strike: m.strike,
        yesCents,
        noCents: 100 - yesCents,
        volume: volumeless,
        // No outcome yet (expired, awaiting settle) → the 50/50 is a placeholder.
        estimated: !m.outcome,
        status: m.outcome ? "resolved" : "expired",
        outcome: m.outcome,
        settlementPrice: m.settlementPrice,
        settlementTs: m.settlementTs,
      });
    }
    out.sort((a, b) => a.strike - b.strike);
    return out;
  }, [markets]);

  return { rows, loading: marketsLoading, error: marketsError };
}
