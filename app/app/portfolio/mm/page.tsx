"use client";

// MM dashboard is wallet-specific; never pre-render at build time.
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletConnectModal } from "@/components/WalletConnectModal";
import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

import {
  Button,
  Card,
  EmptyState,
  IconBolt,
  IconCaret,
  IconRefresh,
  Label,
  Pill,
  SectionTitle,
  Stat,
  fmt$,
} from "@/components/caret";
import { env } from "@/lib/env";
import idl from "@/lib/meridian-idl.json";
import {
  buildAndSendMintPair,
  buildPlaceOrderIx,
  getFeeDestinationUsdc,
} from "@/lib/composite-tx";
import {
  buildAndSendCancelOrder,
  type CancelSide,
} from "@/lib/cancel-order";
import { useAllMarkets } from "@/lib/markets-client";
import { useUserPositions } from "@/lib/positions-client";
import { notify } from "@/lib/notify";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";
import { useMounted, useWalletReady } from "@/lib/use-mounted";
import type { Market } from "@meridian/types";

const ORDERBOOK_SEED = Buffer.from("orderbook");
const YES_MINT_SEED = Buffer.from("yes_mint");

interface OpenOrder {
  market: string;
  ticker: Ticker;
  strike: number;
  side: CancelSide;
  index: number;
  price: number;
  size: number;
  usdcLockedCents: number;
  yesLockedTokens: number;
}

/**
 * Market Maker dashboard — caret-styled, all real on-chain flows preserved:
 *   - useAllMarkets / useUserPositions (read)
 *   - buildAndSendMintPair (mint pairs)
 *   - buildPlaceOrderIx (quote both sides)
 *   - buildAndSendCancelOrder (pull a single quote or cancel-all)
 */
export default function MarketMakerDashboard() {
  const mounted = useMounted();
  const ready = useWalletReady();
  const wallet = useWallet();
  const { connection } = useConnection();
  const [connectOpen, setConnectOpen] = useState(false);
  const connected = mounted && wallet.connected;
  const { markets } = useAllMarkets();
  const { active } = useUserPositions();
  const [refreshKey, setRefreshKey] = useState(0);

  const liveMarkets = useMemo(
    () => markets.filter((m) => !m.settled),
    [markets],
  );
  const { openOrders, loading: ordersLoading } = useUserOpenOrders(
    liveMarkets,
    refreshKey,
  );

  // Selected quote = whichever active order the user clicked. Default to first.
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selected = openOrders[selectedIdx] ?? openOrders[0] ?? null;

  if (!ready) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>Market Maker</h2>
        <div style={{ color: "var(--text-3)", fontSize: 13, fontFamily: "var(--mono)" }}>
          Connecting wallet…
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>Market Maker</h2>
        <EmptyState
          title="Connect a wallet to access MM tools"
          desc="Mint pairs, post limit quotes on the on-chain CLOB, and track exposure across strikes."
          cta="Connect Wallet"
          onCta={() => setConnectOpen(true)}
        />
        <WalletConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      </div>
    );
  }

  // Aggregate stats
  const totalNotionalDollars =
    openOrders.reduce((s, o) => s + (o.price * o.size) / 100, 0);
  const totalInvAbs = active.reduce((s, p) => s + p.quantity, 0);
  const fills24h = 0; // No deterministic source — derived from history later.

  async function handlePullAll() {
    if (openOrders.length === 0) {
      notify.info("No open orders to pull.");
      return;
    }
    let failed = 0;
    for (const o of openOrders) {
      try {
        await buildAndSendCancelOrder(connection, wallet, o.market, o.side, o.index);
      } catch (err) {
        failed += 1;
        console.error("cancel failed", err);
      }
    }
    if (failed === 0) notify.success(`Cancelled ${openOrders.length} order(s).`);
    else
      notify.warning(
        `Cancelled ${openOrders.length - failed}/${openOrders.length} — ${failed} failed.`,
      );
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="page">
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 24,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <Label>Connected · maker tools</Label>
          <h2 style={{ marginTop: 6 }}>Market Maker</h2>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6 }}>
            Mint pairs · Quote both sides · Manage inventory
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            leftIcon={<IconRefresh size={13} />}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            Refresh
          </Button>
          <Button onClick={handlePullAll} disabled={openOrders.length === 0}>
            Pull all quotes
          </Button>
        </div>
      </div>

      {/* SUMMARY */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 1,
          background: "var(--line-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 12,
          overflow: "hidden",
          marginBottom: 24,
        }}
      >
        <SummaryCell
          label="Active quotes"
          value={openOrders.length.toString()}
          aux={`across ${new Set(openOrders.map((o) => o.market)).size} markets`}
        />
        <SummaryCell
          label="Notional quoted"
          value={fmt$(totalNotionalDollars)}
          aux="bid + ask side"
        />
        <SummaryCell
          label="Inventory"
          value={totalInvAbs.toLocaleString()}
          aux="abs tokens held"
        />
        <SummaryCell
          label="Fills (24h)"
          value={fills24h.toString()}
          valueClass="up"
          aux="not yet tracked"
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
        {/* QUOTES TABLE */}
        <Card padding={0}>
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--line-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h3>Active quotes</h3>
            <span className="pill">{openOrders.length} resting</span>
          </div>

          {ordersLoading && openOrders.length === 0 ? (
            <div
              style={{
                padding: 36,
                textAlign: "center",
                color: "var(--text-3)",
                fontSize: 13,
              }}
            >
              Scanning order books…
            </div>
          ) : openOrders.length === 0 ? (
            <div
              style={{
                padding: 36,
                textAlign: "center",
                color: "var(--text-3)",
                fontSize: 13,
              }}
            >
              No resting orders. Use Mint Pairs + Quote Both Sides below to get
              started.
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Side</th>
                  <th style={{ textAlign: "right" }}>Price</th>
                  <th style={{ textAlign: "right" }}>Size</th>
                  <th style={{ textAlign: "right" }}>Locked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((o, i) => {
                  const sel = i === selectedIdx;
                  return (
                    <tr
                      key={`${o.market}-${o.side}-${o.index}`}
                      onClick={() => setSelectedIdx(i)}
                      style={{
                        cursor: "pointer",
                        background: sel ? "var(--accent-soft)" : "transparent",
                      }}
                    >
                      <td>
                        <div
                          style={{ display: "flex", alignItems: "baseline", gap: 6 }}
                        >
                          <span style={{ fontWeight: 500 }}>{o.ticker}</span>
                          <IconCaret
                            size={11}
                            style={{
                              color: "var(--accent)",
                              alignSelf: "center",
                            }}
                          />
                          <span className="num">${(o.strike / 100).toFixed(2)}</span>
                        </div>
                      </td>
                      <td>
                        <span
                          className={o.side === "bid" ? "up mono" : "dn mono"}
                          style={{ fontSize: 11, textTransform: "uppercase" }}
                        >
                          {o.side === "bid" ? "Bid" : "Ask"}
                        </span>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {o.price}¢
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {o.size}
                      </td>
                      <td
                        className="num"
                        style={{ textAlign: "right", color: "var(--text-3)" }}
                      >
                        {o.side === "bid"
                          ? fmt$(o.usdcLockedCents / 100)
                          : `${o.yesLockedTokens} YES`}
                      </td>
                      <td style={{ textAlign: "right", paddingRight: 18 }}>
                        <CancelButton
                          order={o}
                          onCancelled={() => setRefreshKey((k) => k + 1)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* QUOTE EDITOR */}
        <Card padding={20}>
          <SectionTitle action={<Pill>Selected</Pill>}>
            {selected ? (
              <>
                {selected.ticker}{" "}
                <IconCaret
                  size={10}
                  style={{ verticalAlign: "middle", color: "var(--accent)" }}
                />{" "}
                <span className="num">${(selected.strike / 100).toFixed(2)}</span>
              </>
            ) : (
              <span style={{ color: "var(--text-3)", fontSize: 14 }}>
                No quote selected
              </span>
            )}
          </SectionTitle>

          {selected ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <Label style={{ marginBottom: 6 }}>
                  {selected.side === "bid" ? "Bid" : "Ask"} resting
                </Label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border:
                      selected.side === "bid"
                        ? "1px solid var(--up-line)"
                        : "1px solid var(--down-line)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    background:
                      selected.side === "bid" ? "var(--up-soft)" : "var(--down-soft)",
                  }}
                >
                  <span
                    className="label"
                    style={{
                      color:
                        selected.side === "bid" ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {selected.side.toUpperCase()}
                  </span>
                  <span
                    className="num"
                    style={{
                      flex: 1,
                      textAlign: "right",
                      fontWeight: 600,
                      color:
                        selected.side === "bid" ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {selected.price}¢
                  </span>
                </div>
              </div>

              <div
                style={{
                  padding: 12,
                  background: "var(--bg-elev-2)",
                  borderRadius: 8,
                  marginTop: 4,
                }}
              >
                <Stat k="Size" v={`${selected.size} tokens`} />
                <Stat
                  k="USDC locked"
                  v={fmt$(selected.usdcLockedCents / 100)}
                />
                <Stat
                  k="YES locked"
                  v={`${selected.yesLockedTokens} tokens`}
                />
                <Stat k="Implied prob" v={`${selected.price}%`} />
              </div>

              <CancelButton
                order={selected}
                onCancelled={() => setRefreshKey((k) => k + 1)}
                full
              />
            </div>
          ) : (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--text-3)",
                fontSize: 13,
              }}
            >
              Select a row from the quotes table to edit it.
            </div>
          )}
        </Card>
      </div>

      {/* INVENTORY + FILL TAPE */}
      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        <Card padding={20}>
          <SectionTitle action={<Pill>Live</Pill>}>
            Inventory by strike
          </SectionTitle>
          <InventoryChart openOrders={openOrders} />
        </Card>
        <Card padding={20}>
          <SectionTitle action={<Pill>Live</Pill>}>Quote Both Sides</SectionTitle>
          <QuoteBothSidesForm
            markets={liveMarkets}
            onQuoted={() => setRefreshKey((k) => k + 1)}
          />
        </Card>
      </div>

      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        <Card padding={20}>
          <SectionTitle action={<IconBolt size={14} />}>Mint Pairs</SectionTitle>
          <QuickMintForm
            markets={liveMarkets}
            onMinted={() => setRefreshKey((k) => k + 1)}
          />
        </Card>
        <Card padding={0}>
          <div
            style={{ padding: "14px 18px", borderBottom: "1px solid var(--line-soft)" }}
          >
            <h3>Quote Tips</h3>
          </div>
          <div style={{ padding: 20, fontSize: 13, color: "var(--text-2)", lineHeight: 1.6 }}>
            <p style={{ marginBottom: 12 }}>
              <strong style={{ color: "var(--text)" }}>Mint a pair</strong> when you
              want to provide liquidity on both sides without taking directional
              risk. $1.00 in → 1 Yes + 1 No.
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong style={{ color: "var(--text)" }}>Quote both sides</strong> posts
              one bid + one ask around the mid. If both fill you collect the spread.
            </p>
            <p>
              <strong style={{ color: "var(--text)" }}>Pull early</strong> if spot
              moves through your fair value — better to cancel than carry adverse
              inventory.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancel button
// ---------------------------------------------------------------------------
function CancelButton({
  order,
  onCancelled,
  full = false,
}: {
  order: OpenOrder;
  onCancelled: () => void;
  full?: boolean;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);

  async function handle() {
    setBusy(true);
    try {
      await buildAndSendCancelOrder(
        connection,
        wallet,
        order.market,
        order.side,
        order.index,
      );
      notify.success(`Cancelled ${order.ticker} ${order.side} @ ${order.price}¢`);
      onCancelled();
    } catch (err) {
      notify.error(
        `Cancel failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn sm"
      onClick={(e) => {
        e.stopPropagation();
        void handle();
      }}
      disabled={busy}
      style={full ? { width: "100%" } : undefined}
    >
      {busy ? "…" : "Cancel"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Open orders hook (re-uses the original scan logic)
// ---------------------------------------------------------------------------
function useUserOpenOrders(
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

    const programId = (() => {
      try {
        return new PublicKey(env.programId!);
      } catch {
        return null;
      }
    })();
    if (!programId) {
      setOpenOrders([]);
      return;
    }

    const dummyKp = Keypair.generate();
    const dummyWallet = {
      publicKey: dummyKp.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(
        txs: T[],
      ) => txs,
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
            programId!,
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
          // Book missing — skip silently.
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

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------
function SummaryCell({
  label,
  value,
  valueClass,
  aux,
}: {
  label: string;
  value: string;
  valueClass?: string;
  aux?: string;
}) {
  return (
    <div style={{ background: "var(--bg-elev)", padding: "16px 18px" }}>
      <div className="label">{label}</div>
      <div
        className={`num ${valueClass || ""}`}
        style={{ fontSize: 22, fontWeight: 500, marginTop: 6 }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--text-3)",
          marginTop: 2,
          fontFamily: "var(--mono)",
        }}
      >
        {aux}
      </div>
    </div>
  );
}

function InventoryChart({ openOrders }: { openOrders: OpenOrder[] }) {
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { ticker: Ticker; strike: number; exposure: number }
    >();
    for (const o of openOrders) {
      const k = `${o.ticker}-${o.strike}`;
      const cur = map.get(k) ?? { ticker: o.ticker, strike: o.strike, exposure: 0 };
      cur.exposure += o.side === "bid" ? o.size : -o.size;
      map.set(k, cur);
    }
    return Array.from(map.values()).slice(0, 8);
  }, [openOrders]);

  if (grouped.length === 0) {
    return (
      <div
        style={{
          height: 200,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        No inventory exposure.
      </div>
    );
  }
  const W = 360;
  const H = 200;
  const max = Math.max(...grouped.map((d) => Math.abs(d.exposure))) * 1.3 || 1;
  const cellW = W / grouped.length;
  const barW = Math.max(6, cellW - 24);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 200 }}>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="var(--line-soft)" />
      {grouped.map((d, i) => {
        const x = (i + 0.5) * cellW - barW / 2;
        const h = (Math.abs(d.exposure) / max) * (H / 2 - 14);
        const y = d.exposure >= 0 ? H / 2 - h : H / 2;
        const color = d.exposure >= 0 ? "var(--up)" : "var(--down)";
        return (
          <g key={`${d.ticker}-${d.strike}`}>
            <rect x={x} y={y} width={barW} height={h} fill={color} opacity="0.7" rx="3" />
            <text
              x={x + barW / 2}
              y={H - 6}
              textAnchor="middle"
              fontFamily="var(--mono)"
              fontSize="10"
              fill="var(--text-3)"
            >
              {d.ticker}
            </text>
            <text
              x={x + barW / 2}
              y={d.exposure >= 0 ? y - 4 : y + h + 12}
              textAnchor="middle"
              fontFamily="var(--mono)"
              fontSize="10"
              fill={color}
            >
              {d.exposure >= 0 ? "+" : ""}
              {d.exposure}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Quote Both Sides form (wired to buildPlaceOrderIx)
// ---------------------------------------------------------------------------
function QuoteBothSidesForm({
  markets,
  onQuoted,
}: {
  markets: Market[];
  onQuoted: () => void;
}) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [selected, setSelected] = useState("");
  const [midStr, setMidStr] = useState("50");
  const [spreadStr, setSpreadStr] = useState("4");
  const [sizeStr, setSizeStr] = useState("20");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!selected && markets.length > 0) {
      setSelected(markets[0]!.address);
    }
  }, [markets, selected]);

  const target = markets.find((m) => m.address === selected);
  const mid = Math.max(2, Math.min(98, Math.round(Number(midStr) || 50)));
  const spread = Math.max(1, Math.min(50, Math.round(Number(spreadStr) || 1)));
  const size = Math.max(1, Math.floor(Number(sizeStr) || 0));
  const bidPrice = Math.max(1, mid - Math.floor(spread / 2));
  const askPrice = Math.min(99, mid + Math.ceil(spread / 2));
  const pnlIfFilledCents = (askPrice - bidPrice) * size;

  async function handleQuote() {
    if (!target) {
      notify.warning("Select a market first.");
      return;
    }
    if (!wallet.connected || !wallet.publicKey) {
      notify.warning("Wallet not connected.");
      return;
    }
    if (size <= 0) {
      notify.warning("Enter a size > 0.");
      return;
    }
    if (bidPrice >= askPrice) {
      notify.warning("Spread too tight — bid must be below ask.");
      return;
    }
    if (!env.programId || !env.usdcMint) {
      notify.error("Program not configured — can't post quotes.");
      return;
    }

    setSubmitting(true);
    try {
      const programId = new PublicKey(env.programId);
      const provider = new AnchorProvider(connection, wallet as any, {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
      const idlAny = idl as Idl & { address?: string };
      idlAny.address = programId.toBase58();
      const program = new Program(idlAny, provider);

      const marketPk = new PublicKey(target.address);
      const yesMint = PublicKey.findProgramAddressSync(
        [YES_MINT_SEED, marketPk.toBuffer()],
        programId,
      )[0];
      const usdcMint = new PublicKey(env.usdcMint);
      const user = wallet.publicKey;
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
      const userYes = getAssociatedTokenAddressSync(yesMint, user);
      const feeDestinationUsdc = await getFeeDestinationUsdc(program, usdcMint);

      const bidIx = await buildPlaceOrderIx(
        program,
        {
          market: marketPk,
          yesMint,
          usdcMint,
          user,
          userUsdc,
          userYes,
          counterpartyUsdc: userUsdc,
          counterpartyYes: userYes,
          feeDestinationUsdc,
        },
        "bid",
        bidPrice,
        size,
      );
      const askIx = await buildPlaceOrderIx(
        program,
        {
          market: marketPk,
          yesMint,
          usdcMint,
          user,
          userUsdc,
          userYes,
          counterpartyUsdc: userUsdc,
          counterpartyYes: userYes,
          feeDestinationUsdc,
        },
        "ask",
        askPrice,
        size,
      );
      const bidTx = new Transaction().add(bidIx);
      const askTx = new Transaction().add(askIx);
      const bidSig = await provider.sendAndConfirm(bidTx);
      const askSig = await provider.sendAndConfirm(askTx);
      notify.success(
        `Quoted ${size} @ ${bidPrice}¢ / ${askPrice}¢ on ${target.ticker} > $${(target.strike / 100).toFixed(2)}.`,
      );
      notify.info(`Bid: ${bidSig.slice(0, 12)}… · Ask: ${askSig.slice(0, 12)}…`);
      onQuoted();
    } catch (err) {
      notify.error(
        `Quote failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div>
        <Label style={{ marginBottom: 6 }}>Market</Label>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {markets.length === 0 && <option value="">No live markets yet</option>}
          {markets.map((m) => (
            <option key={m.address} value={m.address}>
              {m.ticker} &gt; ${(m.strike / 100).toFixed(2)}
            </option>
          ))}
        </select>
      </div>
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}
      >
        <div>
          <Label style={{ marginBottom: 6 }}>Mid ¢</Label>
          <input
            type="number"
            min={2}
            max={98}
            value={midStr}
            onChange={(e) => setMidStr(e.target.value)}
          />
        </div>
        <div>
          <Label style={{ marginBottom: 6 }}>Spread ¢</Label>
          <input
            type="number"
            min={1}
            value={spreadStr}
            onChange={(e) => setSpreadStr(e.target.value)}
          />
        </div>
        <div>
          <Label style={{ marginBottom: 6 }}>Size</Label>
          <input
            type="number"
            min={1}
            value={sizeStr}
            onChange={(e) => setSizeStr(e.target.value)}
          />
        </div>
      </div>
      <div
        style={{
          padding: 12,
          background: "var(--bg-elev-2)",
          borderRadius: 8,
        }}
      >
        <Stat
          k="Bid / Ask"
          v={`${bidPrice}¢ / ${askPrice}¢`}
        />
        <Stat
          k="P&L if both fill"
          v={fmt$(pnlIfFilledCents / 100)}
          vColor={pnlIfFilledCents >= 0 ? "var(--up)" : "var(--down)"}
        />
      </div>
      <Button
        primary
        onClick={() => void handleQuote()}
        disabled={submitting || !target || size <= 0}
      >
        {submitting
          ? "Submitting…"
          : `Quote ${size} @ ${bidPrice}¢ / ${askPrice}¢`}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick mint form
// ---------------------------------------------------------------------------
function QuickMintForm({
  markets,
  onMinted,
}: {
  markets: Market[];
  onMinted: () => void;
}) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [selected, setSelected] = useState("");
  const [pairsStr, setPairsStr] = useState("10");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!selected && markets.length > 0) {
      setSelected(markets[0]!.address);
    }
  }, [markets, selected]);

  const target = markets.find((m) => m.address === selected);
  const pairs = Math.max(0, Math.floor(Number(pairsStr) || 0));

  async function handleMint() {
    if (!target) {
      notify.warning("Select a market first.");
      return;
    }
    if (pairs <= 0) {
      notify.warning("Enter a pair count > 0.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await buildAndSendMintPair(connection, wallet, {
        ticker: target.ticker as Ticker,
        strike: target.strike,
        amountPairs: pairs,
      });
      notify.success(
        `Minted ${pairs} pair(s) for ${fmt$(pairs)}. Tx: ${res.signature.slice(0, 12)}…`,
      );
      onMinted();
    } catch (err) {
      notify.error(
        `Mint failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <p style={{ fontSize: 12, color: "var(--text-3)" }}>
        $1 USDC → 1 YES + 1 NO. The invariant. Mint when you want pure liquidity
        exposure with zero directional risk.
      </p>
      <div>
        <Label style={{ marginBottom: 6 }}>Market</Label>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {markets.length === 0 && <option value="">No live markets yet</option>}
          {markets.map((m) => (
            <option key={m.address} value={m.address}>
              {m.ticker} &gt; ${(m.strike / 100).toFixed(2)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label style={{ marginBottom: 6 }}>Pair count</Label>
        <input
          type="number"
          min={1}
          value={pairsStr}
          onChange={(e) => setPairsStr(e.target.value)}
        />
      </div>
      <div
        style={{
          padding: 12,
          background: "var(--bg-elev-2)",
          borderRadius: 8,
        }}
      >
        <Stat k="USDC required" v={fmt$(pairs)} />
      </div>
      <Button
        primary
        onClick={() => void handleMint()}
        disabled={submitting || pairs <= 0 || !target}
      >
        {submitting
          ? "Submitting…"
          : `Mint ${pairs} pair${pairs === 1 ? "" : "s"}`}
      </Button>
    </div>
  );
}

// Acknowledge TICKER_NAME to keep the import alive for future quote-row titles.
void TICKER_NAME;
