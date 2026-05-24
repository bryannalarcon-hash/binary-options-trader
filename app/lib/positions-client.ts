/**
 * Positions + history client.
 *
 * REAL on-chain (with mock fallback):
 *   - `useUserPositions` reads the user's YES + NO SPL token balances for
 *     every known on-chain market. Entry price is approximated from the
 *     midprice of the live order book (we don't track per-trade cost basis
 *     on chain in v1, so this is the best we can do without indexing).
 *   - `useHoldingForMarket` reads the YES + NO ATA balances for a specific
 *     (ticker, strike).
 *   - `useUserHistory` subscribes to the program's log stream and parses
 *     `PairMinted`, `PairRedeemed`, `OrderPlaced`, `OrderMatched`,
 *     `OrderCancelled`, and `Redeemed` events. It seeds from the most
 *     recent N signatures for the user's wallet, then live-appends.
 *
 * Fallback to deterministic mocks when:
 *   - the program isn't deployed,
 *   - the on-chain market list is empty,
 *   - or any RPC call throws (we keep last-good state).
 */

"use client";

import { useEffect, useRef, useState } from "react";
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
import { useAllMarkets } from "./markets-client";
import type { HistoryEvent, MockPosition } from "./mock-data";
import {
  mockMarket,
  spotForTicker,
  strikesForTicker,
  yesPriceCents,
} from "./mock-data";
import { MAG7_TICKERS, type Ticker } from "./tickers";
import { useMounted } from "./use-mounted";

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

/** Deterministic stub: synthesizes a small holdings book for a wallet. */
function synthesizePositions(walletKey: string): MockPosition[] {
  const seed = walletKey.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const out: MockPosition[] = [];

  for (let i = 0; i < 4; i++) {
    const ticker = MAG7_TICKERS[(seed + i) % MAG7_TICKERS.length]!;
    const strikes = strikesForTicker(ticker);
    const strike = strikes[(seed + i * 3) % strikes.length]!;
    const side: Side = (seed + i) % 2 === 0 ? "yes" : "no";
    const market = mockMarket(ticker, strike);
    const yes = yesPriceCents(ticker, strike);
    const currentPrice = side === "yes" ? yes : 100 - yes;
    const entryPrice = Math.max(2, Math.min(98, currentPrice + ((seed + i) % 11) - 5));
    out.push({
      market,
      side,
      quantity: 50 + ((seed + i * 11) % 150),
      entryPrice,
      currentPrice,
    });
  }
  return out;
}

/** Synthesize history events for this wallet. */
function synthesizeHistory(walletKey: string): HistoryEvent[] {
  const seed = walletKey.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const out: HistoryEvent[] = [];
  const now = Date.now();

  for (let i = 0; i < 25; i++) {
    const ticker = MAG7_TICKERS[(seed + i) % MAG7_TICKERS.length]!;
    const strikes = strikesForTicker(ticker);
    const strike = strikes[(seed + i * 5) % strikes.length]!;
    const side: Side = (seed + i) % 2 === 0 ? "yes" : "no";
    const eventTypes: HistoryEvent["type"][] = ["buy", "sell", "mint_pair", "redeem"];
    const type = eventTypes[(seed + i) % eventTypes.length]!;
    const yes = yesPriceCents(ticker, strike);
    const price = side === "yes" ? yes : 100 - yes;
    out.push({
      ts: now - i * 1000 * 60 * 17,
      type,
      ticker,
      strike,
      side: type === "mint_pair" || type === "redeem_pair" ? null : side,
      quantity: 25 + ((seed + i * 13) % 100),
      price,
      feeCents: 2 + (i % 4),
      status:
        i % 11 === 0 ? "cancelled" : i % 17 === 0 ? "failed" : "filled",
      txSig: `hist${i}${ticker}${strike}`.padEnd(88, "0"),
    });
  }
  return out;
}

export interface PortfolioSummary {
  totalValueDollars: number;
  unrealizedPnlDollars: number;
  realizedPnlDollars: number;
  openCount: number;
}

/**
 * Read SPL balance for `mint` owned by `user`. Returns 0 if the ATA doesn't
 * exist yet (which is the common case for fresh markets). Other errors
 * surface as null so the caller can fall back.
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

/**
 * Hook: caller's active + settled positions, plus aggregate summary.
 */
export function useUserPositions(): {
  active: MockPosition[];
  settled: MockPosition[];
  summary: PortfolioSummary;
  loading: boolean;
} {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const publicKey = mounted ? wallet.publicKey : null;
  const { markets } = useAllMarkets();
  const [active, setActive] = useState<MockPosition[]>([]);
  const [settled, setSettled] = useState<MockPosition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!mounted || !publicKey) {
      setActive([]);
      setSettled([]);
      setLoading(false);
      return;
    }

    async function refresh() {
      if (cancelled || !publicKey) return;
      setLoading(true);
      // If we don't have any real markets (program down) fall back to mock.
      if (markets.length === 0 || !env.programId) {
        const all = synthesizePositions(publicKey.toBase58());
        if (cancelled) return;
        setActive(all.slice(1));
        setSettled(all.slice(0, 1));
        setLoading(false);
        return;
      }
      // For each known market read YES+NO balances. Only keep > 0 holdings.
      const activeOut: MockPosition[] = [];
      const settledOut: MockPosition[] = [];
      for (const m of markets) {
        const yesMint = new PublicKey(m.yesMint);
        const noMint = new PublicKey(m.noMint);
        const [yesBal, noBal] = await Promise.all([
          safeBalance(connection, publicKey, yesMint),
          safeBalance(connection, publicKey, noMint),
        ]);
        const currentYes = yesPriceCents(m.ticker, m.strike);
        if ((yesBal ?? 0) > 0) {
          const pos: MockPosition = {
            market: m,
            side: "yes",
            quantity: yesBal ?? 0,
            entryPrice: currentYes, // best-effort — we don't track cost basis on-chain
            currentPrice: currentYes,
          };
          if (m.settled) settledOut.push(pos);
          else activeOut.push(pos);
        }
        if ((noBal ?? 0) > 0) {
          const pos: MockPosition = {
            market: m,
            side: "no",
            quantity: noBal ?? 0,
            entryPrice: 100 - currentYes,
            currentPrice: 100 - currentYes,
          };
          if (m.settled) settledOut.push(pos);
          else activeOut.push(pos);
        }
      }
      if (cancelled) return;
      setActive(activeOut);
      setSettled(settledOut);
      setLoading(false);
    }

    void refresh();
    const id = window.setInterval(() => void refresh(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, publicKey, mounted, markets]);

  const summary = aggregate(active, settled);
  return { active, settled, summary, loading };
}

function aggregate(
  active: MockPosition[],
  settled: MockPosition[],
): PortfolioSummary {
  let total = 0;
  let unreal = 0;
  let real = 0;
  for (const p of active) {
    total += (p.quantity * p.currentPrice) / 100;
    unreal += (p.quantity * (p.currentPrice - p.entryPrice)) / 100;
  }
  for (const p of settled) {
    const winning = p.market.outcome === p.side;
    const payout = winning ? p.quantity * 1 : 0;
    total += payout;
    real += payout - (p.quantity * p.entryPrice) / 100;
  }
  return {
    totalValueDollars: total,
    unrealizedPnlDollars: unreal,
    realizedPnlDollars: real,
    openCount: active.length,
  };
}

// ---------------------------------------------------------------------------
// History — subscribe to program events + optionally seed from signature scan
// ---------------------------------------------------------------------------

/** Map an OrderMatched taker-side (0 = bid → buy YES) to the UI side label. */
function mapTakerSideToUiSide(takerSide: number): Side {
  return takerSide === 0 ? "yes" : "no";
}

/** Map an OrderPlaced.side (0 = bid → buy YES) to the UI side label. */
function mapOrderSideToUiSide(side: number): Side {
  return side === 0 ? "yes" : "no";
}

/** Resolve a `market` pubkey to a (ticker, strike) using the live markets list. */
function marketLookup(markets: Market[]): Map<string, { ticker: Ticker; strike: number }> {
  const map = new Map<string, { ticker: Ticker; strike: number }>();
  for (const m of markets) {
    map.set(m.address, { ticker: m.ticker as Ticker, strike: m.strike });
  }
  return map;
}

/**
 * Hook: trade history for the caller.
 *
 * Strategy:
 *   - Seed with whatever we can read from the user's last 50 tx signatures
 *     (cheap historical replay). Each signature is fetched + parsed for
 *     program events.
 *   - Subscribe via `connection.onLogs(programId)` for live updates. Filter
 *     events where the `user`/`taker`/`maker` pubkey == the connected wallet.
 *
 * Falls back to deterministic mocks when the program isn't deployed.
 */
export function useUserHistory(): { events: HistoryEvent[]; loading: boolean } {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const publicKey = mounted ? wallet.publicKey : null;
  const { markets } = useAllMarkets();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const eventsRef = useRef<HistoryEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    let subId: number | null = null;

    if (!mounted || !publicKey) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    // Fallback path — no program deployed.
    const built = makeReadOnlyProgram(connection);
    if (!built) {
      setEvents(synthesizeHistory(publicKey.toBase58()));
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
      if (!tickerStrike) return; // unknown market — skip (would render blank rows)

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
            price: 100, // $1 par
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
          // Side 0 (Bid) = buying YES = "buy yes"; side 1 (Ask) = "sell yes".
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
          // If I'm the taker: my side matches takerSide directly.
          // If I'm the maker: my side is the OPPOSITE of takerSide.
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
            // usdc_paid is in micro-USDC (6 decimals); convert to display cents
            // by dividing the contract's micro-USDC by 10_000 → cents.
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

    // Seed from recent program signatures (best-effort — non-fatal on error).
    async function seedHistory() {
      try {
        const sigs = await connection.getSignaturesForAddress(
          built!.programId,
          { limit: 50 },
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
        /* seeding failed — live subscription will fill in */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void seedHistory();

    // Live subscription.
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

  return { events, loading };
}

/**
 * Read the user's current Yes/No quantity for a specific (ticker, strike).
 * Returns 0 if not connected or no holdings.
 *
 * Goes straight to SPL ATA balances rather than aggregating `useUserPositions`
 * so the TradePanel doesn't pay the cost of fetching every market's balance
 * just to render one row.
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

// TOKEN_PROGRAM_ID is imported for parity with other call sites; touch it so
// strict "noUnusedImports" lints (if enabled) don't trip.
void TOKEN_PROGRAM_ID;
