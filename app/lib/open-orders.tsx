"use client";

/**
 * Shared "open orders" reader + a trade-page panel.
 *
 * A RESTING order (a limit bid/ask that hasn't filled) is NOT a position — you
 * don't own any tokens yet, so it never shows on /portfolio. It only lived on
 * the Market Maker page, which a normal trader wouldn't think to check. This
 * surfaces a wallet's resting orders for the current market right on the trade
 * page, with a Cancel button (cancel returns the escrowed USDC / YES).
 */

import { useEffect, useMemo, useState } from "react";
import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
} from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import type { Market, Ticker } from "@meridian/types";
import { env } from "./env";
import idl from "./meridian-idl.json";
import { buildAndSendCancelOrder, type CancelSide } from "./cancel-order";
import { fmtUsdDollars } from "./format";
import { notify } from "./notify";
import { useMounted } from "./use-mounted";

const ORDERBOOK_SEED = Buffer.from("orderbook");

export interface OpenOrder {
  market: string;
  ticker: Ticker;
  strike: number;
  side: CancelSide;
  index: number;
  price: number; // cents
  size: number; // tokens
  usdcLockedCents: number;
  yesLockedTokens: number;
}

/**
 * Read the connected wallet's resting bids/asks across `markets`. Polls every
 * 12s; bump `refreshKey` to force an immediate re-scan (e.g. after a cancel or
 * a new order). Real on-chain only.
 */
export function useUserOpenOrders(
  markets: Market[],
  refreshKey: number,
): { openOrders: OpenOrder[]; loading: boolean } {
  const { connection } = useConnection();
  const wallet = useWallet();
  const mounted = useMounted();
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!mounted || !wallet.publicKey || markets.length === 0 || !env.programId) {
      setOpenOrders([]);
      return;
    }
    let programId: PublicKey;
    try {
      programId = new PublicKey(env.programId);
    } catch {
      setOpenOrders([]);
      return;
    }

    const dummyKp = Keypair.generate();
    const dummyWallet = {
      publicKey: dummyKp.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) =>
        txs,
      payer: dummyKp,
    };
    const provider = new AnchorProvider(connection, dummyWallet as any, {
      commitment: "confirmed",
    });
    const idlAny = idl as Idl & { address?: string };
    idlAny.address = programId.toBase58();
    const program = new Program(idlAny, provider);
    const myKey = wallet.publicKey.toBase58();

    async function scan() {
      setLoading(true);
      const acc: OpenOrder[] = [];
      for (const m of markets) {
        if (cancelled) break;
        try {
          const marketPk = new PublicKey(m.address);
          const obPda = PublicKey.findProgramAddressSync(
            [ORDERBOOK_SEED, marketPk.toBuffer()],
            programId,
          )[0];
          const raw = (await (program.account as any).orderBook.fetch(obPda)) as {
            bids: Array<{ owner: PublicKey; price: number; size: BN }>;
            asks: Array<{ owner: PublicKey; price: number; size: BN }>;
          };
          for (let i = 0; i < (raw.bids?.length ?? 0); i++) {
            const b = raw.bids[i];
            if (!b || b.owner.equals(PublicKey.default) || b.size.isZero()) continue;
            if (b.owner.toBase58() !== myKey) continue;
            const sz = Number(b.size.toString());
            acc.push({
              market: m.address,
              ticker: m.ticker as Ticker,
              strike: m.strike,
              side: "bid",
              index: i,
              price: Number(b.price),
              size: sz,
              usdcLockedCents: Number(b.price) * sz,
              yesLockedTokens: 0,
            });
          }
          for (let i = 0; i < (raw.asks?.length ?? 0); i++) {
            const a = raw.asks[i];
            if (!a || a.owner.equals(PublicKey.default) || a.size.isZero()) continue;
            if (a.owner.toBase58() !== myKey) continue;
            const sz = Number(a.size.toString());
            acc.push({
              market: m.address,
              ticker: m.ticker as Ticker,
              strike: m.strike,
              side: "ask",
              index: i,
              price: Number(a.price),
              size: sz,
              usdcLockedCents: 0,
              yesLockedTokens: sz,
            });
          }
        } catch {
          /* book missing — skip */
        }
      }
      if (!cancelled) {
        setOpenOrders(acc);
        setLoading(false);
      }
    }
    void scan();
    const id = window.setInterval(() => void scan(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, wallet.publicKey, mounted, markets, refreshKey]);

  return { openOrders, loading };
}

function CancelOrderButton({
  order,
  onCancelled,
}: {
  order: OpenOrder;
  onCancelled: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await buildAndSendCancelOrder(connection, wallet, order.market, order.side, order.index);
          notify.success(`Cancelled ${order.side} @ ${order.price}¢ · escrow returned`);
          onCancelled();
        } catch (err) {
          notify.error(`Cancel failed: ${err instanceof Error ? err.message : "unknown"}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : "Cancel"}
    </button>
  );
}

/**
 * Trade-page panel: the connected wallet's RESTING orders on THIS market, each
 * cancellable. Renders nothing when there are none (so it stays out of the way).
 */
export function OpenOrdersForMarket({ market }: { market: Market | null }) {
  const wallet = useWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const markets = useMemo(() => (market ? [market] : []), [market]);
  const { openOrders } = useUserOpenOrders(markets, refreshKey);

  if (!wallet.connected || openOrders.length === 0) return null;

  return (
    <div
      data-testid="open-orders-panel"
      style={{
        marginTop: 10,
        padding: "10px 12px",
        border: "1px solid var(--line-soft)",
        borderRadius: 8,
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span className="label">Your open orders (resting — not yet filled)</span>
        <span className="pill" style={{ fontSize: 10 }}>
          {openOrders.length}
        </span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {openOrders.map((o) => (
          <div
            key={`${o.side}-${o.index}-${o.price}`}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--mono)",
              fontSize: 12,
            }}
          >
            <span
              className={o.side === "bid" ? "up" : "dn"}
              style={{ textTransform: "uppercase", fontWeight: 600 }}
            >
              {o.side === "bid" ? "Buy" : "Sell"} YES
            </span>
            <span style={{ color: "var(--text-2)" }}>
              {o.size} @ {o.price}¢
              <span style={{ color: "var(--text-3)" }}>
                {" "}
                ·{" "}
                {o.side === "bid"
                  ? `${fmtUsdDollars(o.usdcLockedCents / 100)} USDC locked`
                  : `${o.yesLockedTokens} YES locked`}
              </span>
            </span>
            <CancelOrderButton order={o} onCancelled={() => setRefreshKey((k) => k + 1)} />
          </div>
        ))}
      </div>
    </div>
  );
}
