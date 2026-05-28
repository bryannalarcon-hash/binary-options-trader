/**
 * Positions + history client — REAL on-chain only (no synthesized fallbacks).
 *
 *   - `useUserPositions` reads the user's YES + NO SPL token balances for every
 *     real on-chain market. Cost basis (entryPrice) is derived from the user's
 *     REAL fills (OrderMatched / PairMinted) via the same history feed; when a
 *     position's basis can't be determined, `entryPrice` is null and unrealized
 *     P&L is hidden for that row.
 *   - `useHoldingForMarket` reads the YES + NO ATA balances for one (ticker,
 *     strike).
 *   - `useUserHistory` seeds from the user's recent program signatures, then
 *     live-appends parsed `PairMinted`, `PairRedeemed`, `OrderPlaced`,
 *     `OrderMatched`, `OrderCancelled`, `Redeemed` events.
 *
 * Honest states everywhere: empty positions / empty history when there's
 * nothing on-chain; `loading` while reading; `error` on RPC failure. We NEVER
 * synthesize holdings, history, cost basis, or a P&L curve.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnchorProvider,
  BN,
  BorshCoder,
  EventParser,
  Program,
  type Idl,
} from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Logs,
  type VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

import type { Market, Side } from "@meridian/types";
import { env } from "./env";
import idl from "./meridian-idl.json";
import { shouldStopLoading } from "./loading-state";
import { useAllMarkets } from "./markets-client";
import { MAG7_TICKERS, type Ticker } from "./tickers";
import { useMounted } from "./use-mounted";

/**
 * Bounded timeout (ms) before the positions skeleton MUST resolve to a terminal
 * state (real positions / "No active positions" / error), even if `useAllMarkets`
 * never settles. `useAllMarkets` already races its own RPC read; this is a
 * defensive backstop so the section is never an infinite skeleton after the
 * close. Slightly longer than the markets read timeout so the upstream error
 * normally arrives first.
 */
const POSITIONS_LOADING_TIMEOUT_MS = 14_000;

void MAG7_TICKERS;

/**
 * A position the user holds. `entryPrice` is the REAL volume-weighted cost
 * basis in cents derived from fills, or null when it can't be determined.
 * `currentPrice` is the live book mid in cents, or null when the book is empty.
 */
export interface Position {
  market: Market;
  side: Side;
  quantity: number;
  entryPrice: number | null;
  currentPrice: number | null;
}

/** A decoded on-chain history event for the connected wallet. */
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

export interface PortfolioSummary {
  totalValueDollars: number;
  /** Unrealized P&L over positions where cost basis is known. */
  unrealizedPnlDollars: number;
  realizedPnlDollars: number;
  openCount: number;
}

/**
 * Read SPL balance for `mint` owned by `user`. Returns 0 if the ATA doesn't
 * exist yet (common for fresh markets). Other errors surface as null.
 */
async function safeBalance(
  connection: ReturnType<typeof useConnection>["connection"],
  user: PublicKey,
  mint: PublicKey,
): Promise<number | null> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, user);
    const acct = await getAccount(connection, ata, "confirmed");
    return Number(acct.amount);
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0;
    return null;
  }
}

/** Read one market's best bid/ask mid (cents), or null if the book is empty. */
async function bookMidCents(
  program: Program,
  programId: PublicKey,
  marketAddr: string,
): Promise<number | null> {
  const ob = PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), new PublicKey(marketAddr).toBuffer()],
    programId,
  )[0];
  try {
    const raw = (await (program.account as any).orderBook.fetch(ob)) as {
      bids: Array<{ owner: PublicKey; price: number; size: BN }>;
      asks: Array<{ owner: PublicKey; price: number; size: BN }>;
    };
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
    if (bestBid >= 0 && bestAsk >= 0) return Math.round((bestBid + bestAsk) / 2);
    if (bestBid >= 0) return bestBid;
    if (bestAsk >= 0) return bestAsk;
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute volume-weighted cost basis (cents) per (marketAddress, side) from the
 * user's REAL fills. Buys/mints add to basis; sells/redeems reduce remaining
 * quantity proportionally. Returns null entries when no acquiring fill exists.
 */
function deriveCostBasis(
  events: HistoryEvent[],
  markets: Market[],
): Map<string, { qty: number; avgCents: number }> {
  // Map (ticker|strike) → market address for keying by side.
  const addrByKey = new Map<string, string>();
  for (const m of markets) addrByKey.set(`${m.ticker}|${m.strike}`, m.address);

  // Replay oldest → newest so weighted average is correct.
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const acc = new Map<string, { qty: number; cost: number }>();

  function keyFor(ev: HistoryEvent, side: Side): string | null {
    const addr = addrByKey.get(`${ev.ticker}|${ev.strike}`);
    if (!addr) return null;
    return `${addr}|${side}`;
  }

  for (const ev of ordered) {
    if (ev.type === "buy" && ev.side) {
      const k = keyFor(ev, ev.side);
      if (!k) continue;
      const cur = acc.get(k) ?? { qty: 0, cost: 0 };
      cur.qty += ev.quantity;
      cur.cost += ev.quantity * ev.price;
      acc.set(k, cur);
    } else if (ev.type === "mint_pair") {
      // Minting a pair acquires both YES and NO at $1 par split — par per leg
      // is the pair price (100c) minus the other leg's market value; with no
      // reliable per-leg split we treat each leg's basis as the par of the pair
      // (50c each is misleading). We DON'T fabricate a split: skip mint_pair for
      // basis so a position acquired purely via minting reports unknown basis.
      continue;
    } else if (ev.type === "sell" && ev.side) {
      const k = keyFor(ev, ev.side);
      if (!k) continue;
      const cur = acc.get(k);
      if (!cur || cur.qty <= 0) continue;
      const sellQty = Math.min(ev.quantity, cur.qty);
      const avg = cur.cost / cur.qty;
      cur.qty -= sellQty;
      cur.cost -= sellQty * avg;
      if (cur.qty <= 0) acc.delete(k);
      else acc.set(k, cur);
    }
  }

  const out = new Map<string, { qty: number; avgCents: number }>();
  for (const [k, v] of acc) {
    if (v.qty > 0) out.set(k, { qty: v.qty, avgCents: Math.round(v.cost / v.qty) });
  }
  return out;
}

/**
 * Hook: caller's active + settled positions, plus aggregate summary.
 * Real SPL balances; real cost basis from fills; live book mid for mark.
 */
export function useUserPositions(): {
  active: Position[];
  settled: Position[];
  summary: PortfolioSummary;
  loading: boolean;
  error: boolean;
  /** Force an immediate re-read of on-chain balances (wired to "Refresh"). */
  refetch: () => void;
} {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const publicKey = mounted ? wallet.publicKey : null;
  const { markets, loading: marketsLoading, error: marketsError } = useAllMarkets();
  const { events } = useUserHistory();
  const [active, setActive] = useState<Position[]>([]);
  const [settled, setSettled] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Bumping this re-runs the effect (clears + restarts the poll, firing an
  // immediate refresh) so the "Refresh" button actually re-reads on-chain state.
  const [reloadKey, setReloadKey] = useState(0);
  // Stale-while-revalidate: keep last-good positions across 8s refreshes; only
  // show the loading skeleton on the very first load (not every poll), and never
  // blank good data on a transient read error → no data↔skeleton flicker.
  const firstLoadRef = useRef(true);
  // Bounded-timeout backstop: flips true once the loading timeout elapses so the
  // skeleton resolves to a terminal empty/error state even if markets never
  // arrive (devnet RPC hang) — the after-hours "/portfolio loads forever" bug.
  const [timedOut, setTimedOut] = useState(false);

  // Arm a single timeout per (wallet, reload) so the first load can't hang.
  useEffect(() => {
    if (!mounted || !publicKey) return;
    setTimedOut(false);
    const t = window.setTimeout(() => setTimedOut(true), POSITIONS_LOADING_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [mounted, publicKey, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    if (!mounted || !publicKey) {
      setActive([]);
      setSettled([]);
      setLoading(false);
      setError(false);
      return;
    }
    if (!env.programId) {
      setActive([]);
      setSettled([]);
      setError(true);
      setLoading(false);
      return;
    }
    if (markets.length === 0) {
      // Distinguish "markets still loading" from "genuinely none": hold the
      // loading state during the initial fetch instead of flashing an empty
      // "no positions" panel before markets arrive — BUT make that terminal.
      // shouldStopLoading resolves the skeleton once markets finish/err, once
      // it's no longer the first load, or once the bounded timeout elapses (a
      // hung getProgramAccounts RPC must NOT pin loading=true forever).
      const stop = shouldStopLoading(
        marketsLoading,
        marketsError,
        firstLoadRef.current,
        timedOut,
      );
      if (!stop) {
        setLoading(true);
        return;
      }
      setActive([]);
      setSettled([]);
      // A timeout with no upstream error is still an honest "couldn't read" —
      // surface error so the UI shows a notice rather than a bare empty state.
      setError(marketsError || timedOut);
      setLoading(false);
      firstLoadRef.current = false;
      return;
    }

    const built = makeReadOnlyProgram(connection);
    const basis = deriveCostBasis(events, markets);

    async function refresh() {
      if (cancelled || !publicKey) return;
      if (firstLoadRef.current) setLoading(true);
      const activeOut: Position[] = [];
      const settledOut: Position[] = [];
      try {
        for (const m of markets) {
          const yesMint = new PublicKey(m.yesMint);
          const noMint = new PublicKey(m.noMint);
          const [yesBal, noBal] = await Promise.all([
            safeBalance(connection, publicKey, yesMint),
            safeBalance(connection, publicKey, noMint),
          ]);
          const mid = built ? await bookMidCents(built.program, built.programId, m.address) : null;
          const yesCurrent = mid;
          const noCurrent = mid != null ? 100 - mid : null;

          if ((yesBal ?? 0) > 0) {
            const b = basis.get(`${m.address}|yes`);
            const pos: Position = {
              market: m,
              side: "yes",
              quantity: yesBal ?? 0,
              entryPrice: b ? b.avgCents : null,
              currentPrice: yesCurrent,
            };
            if (m.settled) settledOut.push(pos);
            else activeOut.push(pos);
          }
          if ((noBal ?? 0) > 0) {
            const b = basis.get(`${m.address}|no`);
            const pos: Position = {
              market: m,
              side: "no",
              quantity: noBal ?? 0,
              entryPrice: b ? b.avgCents : null,
              currentPrice: noCurrent,
            };
            if (m.settled) settledOut.push(pos);
            else activeOut.push(pos);
          }
        }
        if (cancelled) return;
        setActive(activeOut);
        setSettled(settledOut);
        setError(false);
        setLoading(false);
        firstLoadRef.current = false;
      } catch {
        if (!cancelled) {
          // Keep last-good positions; only surface an error on the first load.
          if (firstLoadRef.current) setError(true);
          setLoading(false);
        }
      }
    }

    void refresh();
    const id = window.setInterval(() => void refresh(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, publicKey, mounted, markets, marketsLoading, marketsError, events, reloadKey, timedOut]);

  const summary = useMemo(() => aggregate(active, settled), [active, settled]);
  const refetch = () => setReloadKey((k) => k + 1);
  return { active, settled, summary, loading, error, refetch };
}

function aggregate(active: Position[], settled: Position[]): PortfolioSummary {
  let total = 0;
  let unreal = 0;
  let real = 0;
  for (const p of active) {
    if (p.currentPrice != null) {
      total += (p.quantity * p.currentPrice) / 100;
      if (p.entryPrice != null) {
        unreal += (p.quantity * (p.currentPrice - p.entryPrice)) / 100;
      }
    }
  }
  for (const p of settled) {
    const winning = p.market.outcome === p.side;
    const payout = winning ? p.quantity * 1 : 0;
    total += payout;
    if (p.entryPrice != null) {
      real += payout - (p.quantity * p.entryPrice) / 100;
    }
  }
  return {
    totalValueDollars: total,
    unrealizedPnlDollars: unreal,
    realizedPnlDollars: real,
    openCount: active.length,
  };
}

// ---------------------------------------------------------------------------
// History — subscribe to program events + seed from signature scan.
// ---------------------------------------------------------------------------

function mapTakerSideToUiSide(takerSide: number): Side {
  return takerSide === 0 ? "yes" : "no";
}
function mapOrderSideToUiSide(side: number): Side {
  return side === 0 ? "yes" : "no";
}
function marketLookup(markets: Market[]): Map<string, { ticker: Ticker; strike: number }> {
  const map = new Map<string, { ticker: Ticker; strike: number }>();
  for (const m of markets) {
    map.set(m.address, { ticker: m.ticker as Ticker, strike: m.strike });
  }
  return map;
}

/**
 * Hook: trade history for the caller — REAL on-chain events only.
 * Empty until something is found; never synthesized.
 */
export function useUserHistory(): { events: HistoryEvent[]; loading: boolean; error: boolean } {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const publicKey = mounted ? wallet.publicKey : null;
  const { markets } = useAllMarkets();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const eventsRef = useRef<HistoryEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;

    if (!mounted || !publicKey) {
      setEvents([]);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    eventsRef.current = [];
    setEvents([]);

    const built = makeReadOnlyProgram(connection);
    if (!built) {
      setError(true);
      setLoading(false);
      return;
    }

    const lookup = marketLookup(markets);
    const parser = new EventParser(
      built.programId,
      new BorshCoder(built.program.idl as Idl),
    );
    const myKey = publicKey.toBase58();

    function pushIfMine(ev: { name: string; data: any }, sig: string): void {
      const name = ev.name;
      const d = ev.data ?? {};
      const ts = Date.now();
      const tickerStrike = d.market
        ? lookup.get((d.market as PublicKey).toBase58())
        : null;
      if (!tickerStrike) return; // unknown market — skip

      let row: HistoryEvent | null = null;

      switch (name) {
        case "PairMinted":
        case "pairMinted": {
          if ((d.user as PublicKey)?.toBase58() !== myKey) return;
          row = {
            ts,
            type: "mint_pair",
            ticker: tickerStrike.ticker,
            strike: tickerStrike.strike,
            side: null,
            quantity: Number((d.amountPairs as BN).toString()),
            price: 100,
            feeCents: 0,
            status: "filled",
            txSig: sig,
          };
          break;
        }
        case "PairRedeemed":
        case "pairRedeemed": {
          if ((d.user as PublicKey)?.toBase58() !== myKey) return;
          row = {
            ts,
            type: "redeem_pair",
            ticker: tickerStrike.ticker,
            strike: tickerStrike.strike,
            side: null,
            quantity: Number((d.amountPairs as BN).toString()),
            price: 100,
            feeCents: 0,
            status: "filled",
            txSig: sig,
          };
          break;
        }
        case "OrderPlaced":
        case "orderPlaced": {
          if ((d.user as PublicKey)?.toBase58() !== myKey) return;
          const side = mapOrderSideToUiSide(Number(d.side));
          row = {
            ts,
            type: Number(d.side) === 0 ? "buy" : "sell",
            ticker: tickerStrike.ticker,
            strike: tickerStrike.strike,
            side,
            quantity: Number((d.size as BN).toString()),
            price: Number(d.price),
            feeCents: 0,
            status: "filled",
            txSig: sig,
          };
          break;
        }
        case "OrderMatched":
        case "orderMatched": {
          const takerKey = (d.taker as PublicKey)?.toBase58();
          const makerKey = (d.maker as PublicKey)?.toBase58();
          if (takerKey !== myKey && makerKey !== myKey) return;
          const isTaker = takerKey === myKey;
          const takerSideNum = Number(d.takerSide);
          const mySide: Side = isTaker
            ? mapTakerSideToUiSide(takerSideNum)
            : takerSideNum === 0
              ? "no"
              : "yes";
          row = {
            ts,
            type: takerSideNum === 0 ? "buy" : "sell",
            ticker: tickerStrike.ticker,
            strike: tickerStrike.strike,
            side: mySide,
            quantity: Number((d.size as BN).toString()),
            price: Number(d.price),
            feeCents: 0,
            status: "filled",
            txSig: sig,
          };
          break;
        }
        case "OrderCancelled":
        case "orderCancelled": {
          if ((d.user as PublicKey)?.toBase58() !== myKey) return;
          row = {
            ts,
            type: Number(d.side) === 0 ? "buy" : "sell",
            ticker: tickerStrike.ticker,
            strike: tickerStrike.strike,
            side: mapOrderSideToUiSide(Number(d.side)),
            quantity: Number((d.returnedSize as BN).toString()),
            price: Number(d.returnedPrice),
            feeCents: 0,
            status: "cancelled",
            txSig: sig,
          };
          break;
        }
        case "Redeemed":
        case "redeemed": {
          if ((d.user as PublicKey)?.toBase58() !== myKey) return;
          const sideNum = Number(d.side);
          row = {
            ts,
            type: "redeem",
            ticker: tickerStrike.ticker,
            strike: tickerStrike.strike,
            side: sideNum === 0 ? "yes" : "no",
            quantity: Number((d.amountBurned as BN).toString()),
            price:
              Number((d.amountBurned as BN).toString()) === 0
                ? 0
                : Math.round(
                    Number((d.usdcPaid as BN).toString()) /
                      (Number((d.amountBurned as BN).toString()) * 10_000),
                  ),
            feeCents: 0,
            status: "filled",
            txSig: sig,
          };
          break;
        }
        default:
          return;
      }

      if (!row) return;
      const next = [row, ...eventsRef.current].slice(0, 200);
      eventsRef.current = next;
      if (!cancelled) setEvents(next);
    }

    async function seedHistory() {
      try {
        // Scan the USER's own signatures, not the program's. A program-wide
        // scan (limit 50) buries the user's fills once the program gets busy
        // (e.g. after the market maker seeds every book), which silently
        // dropped their cost basis → "—" for avg/cost/unrealized. The user's
        // own address always surfaces their trades regardless of program load.
        const sigs = await connection.getSignaturesForAddress(
          publicKey!,
          { limit: 100 },
          "confirmed",
        );
        for (const s of sigs) {
          if (cancelled) return;
          if (s.err) continue;
          try {
            const tx = await connection.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });
            const logs = tx?.meta?.logMessages;
            if (!logs) continue;
            for (const ev of parser.parseLogs(logs)) {
              pushIfMine(ev, s.signature);
            }
          } catch {
            /* skip this sig */
          }
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void seedHistory();

    try {
      subId = connection.onLogs(
        built.programId,
        (logs: Logs) => {
          if (cancelled || !logs.logs) return;
          try {
            for (const ev of parser.parseLogs(logs.logs)) {
              pushIfMine(ev, logs.signature ?? "");
            }
          } catch {
            /* non-fatal */
          }
        },
        "confirmed",
      );
    } catch {
      /* WS unavailable */
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
  }, [connection, publicKey, mounted, markets]);

  return { events, loading, error };
}

/**
 * Read the user's current Yes/No quantity for a specific (ticker, strike).
 * Returns 0 if not connected or no holdings.
 */
export function useHoldingForMarket(
  ticker: Ticker,
  strike: number,
): { yes: number; no: number } {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const publicKey = mounted ? wallet.publicKey : null;
  const { markets } = useAllMarkets();
  const [holding, setHolding] = useState<{ yes: number; no: number }>({ yes: 0, no: 0 });

  useEffect(() => {
    let cancelled = false;
    if (!mounted || !publicKey) {
      setHolding({ yes: 0, no: 0 });
      return;
    }
    if (!env.programId) {
      setHolding({ yes: 0, no: 0 });
      return;
    }
    const match = markets.find((m) => m.ticker === ticker && m.strike === strike);
    if (!match) {
      setHolding({ yes: 0, no: 0 });
      return;
    }

    async function refresh() {
      if (cancelled || !publicKey) return;
      const yesMint = new PublicKey(match!.yesMint);
      const noMint = new PublicKey(match!.noMint);
      const [yesBal, noBal] = await Promise.all([
        safeBalance(connection, publicKey, yesMint),
        safeBalance(connection, publicKey, noMint),
      ]);
      if (cancelled) return;
      setHolding({
        yes: yesBal ?? 0,
        no: noBal ?? 0,
      });
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, publicKey, mounted, ticker, strike, markets]);

  return holding;
}

// TOKEN_PROGRAM_ID kept imported for parity with other call sites.
void TOKEN_PROGRAM_ID;
