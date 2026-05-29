"use client";

// Portfolio is wallet-specific; never pre-render at build time.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletConnectModal } from "@/components/WalletConnectModal";

import {
  Button,
  CaretMark,
  Card,
  IconCaret,
  IconCheckCircle,
  IconRefresh,
  IconXCircle,
  Label,
  SectionTitle,
  StrikePill,
  fmt$,
  fmtPct,
} from "@/components/caret";
import { RedeemConfirmationModal } from "@/components/RedeemConfirmationModal";
import { fmtUsdDollars } from "@/lib/format";
import { useSpotPrice } from "@/lib/markets-client";
import { useUserPositions, type Position } from "@/lib/positions-client";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";
import { useUsdcBalance } from "@/lib/usdc";
import { useMounted, useWalletReady } from "@/lib/use-mounted";

/**
 * Portfolio — caret design ported from prototype/js/portfolio.jsx.
 *
 * All data hooks preserved:
 *   - useUserPositions (real on-chain SPL balances with mock fallback)
 *   - useUsdcBalance
 *   - buildAndSendRedeem (via RedeemConfirmationModal)
 */
export default function PortfolioPage() {
  const mounted = useMounted();
  const ready = useWalletReady();
  const wallet = useWallet();
  const [connectOpen, setConnectOpen] = useState(false);
  const connected = mounted && wallet.connected;
  const usdc = useUsdcBalance();
  const { active, settled, loading, error, refetch } = useUserPositions();
  const [redeemTarget, setRedeemTarget] = useState<Position[] | null>(null);

  // Hold a stable loading state until autoConnect resolves, so we don't flash
  // the "connect wallet" prompt before a persisted wallet reconnects.
  if (!ready) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>Portfolio</h2>
        <div style={{ color: "var(--text-3)", fontSize: 13, fontFamily: "var(--mono)" }}>
          Connecting wallet…
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>Portfolio</h2>
        <EmptyState
          title="Connect a wallet to see your positions"
          desc="Meridian is non-custodial. Phantom, Solflare, and Backpack all work on Solana devnet."
          cta="Connect Wallet"
          onCta={() => setConnectOpen(true)}
        />
        <WalletConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      </div>
    );
  }

  // Totals only count positions where basis / mark are KNOWN. We never invent
  // a cost basis or mark, so unknown-basis rows are excluded from P&L math.
  const totalCost = active.reduce(
    (s, p) => (p.entryPrice != null ? s + (p.entryPrice * p.quantity) / 100 : s),
    0,
  );
  const totalMark = active.reduce(
    (s, p) => (p.currentPrice != null ? s + (p.currentPrice * p.quantity) / 100 : s),
    0,
  );
  const totalMtm = active.reduce(
    (s, p) =>
      p.currentPrice != null && p.entryPrice != null
        ? s + ((p.currentPrice - p.entryPrice) * p.quantity) / 100
        : s,
    0,
  );
  const settledPnl = settled.reduce((s, p) => {
    const winning = p.market.outcome === p.side;
    const payout = winning ? p.quantity : 0;
    return p.entryPrice != null ? s + payout - (p.entryPrice * p.quantity) / 100 : s;
  }, 0);
  // "In the money" = the market currently prices YOUR side above 50¢ (favored
  // to win at settlement → would pay $1/token if it settled now). This is the
  // SAME basis as the per-row ITM/OTM pill, so a position is never labelled
  // "winning" in one place and "losing" in another. Unrealized P&L (mark vs
  // your entry) is a separate number shown alongside.
  const itmCount = active.filter((p) => p.currentPrice != null && p.currentPrice > 50).length;
  const markedCount = active.filter((p) => p.currentPrice != null).length;
  const otmCount = markedCount - itmCount;
  const winRate = markedCount === 0 ? 0 : Math.round((itmCount / markedCount) * 100);

  // Redeemable = the WINNING side of a settled market (pays $1.00/token). This
  // is the single source for both the aggregate "Redeem all winnings" action and
  // the per-row Redeem buttons, so they never disagree about what's claimable.
  const redeemable = settled.filter((p) => p.market.outcome === p.side);
  const redeemableTokens = redeemable.reduce((s, p) => s + p.quantity, 0);

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
          <Label>Connected{wallet.publicKey ? ` · ${shortAddr(wallet.publicKey.toBase58())}` : ""}</Label>
          <h2 style={{ marginTop: 6 }}>Portfolio</h2>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6 }}>
            {active.length} open · {settled.length} settled (last 30d)
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            leftIcon={<IconRefresh size={13} />}
            onClick={() => refetch()}
          >
            Refresh
          </Button>
          {redeemable.length > 0 && (
            <Button primary onClick={() => setRedeemTarget(redeemable)}>
              Redeem {redeemableTokens} winning token{redeemableTokens === 1 ? "" : "s"} · {fmt$(redeemableTokens)}
            </Button>
          )}
        </div>
      </div>

      {/* SUMMARY ROW */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 1,
          background: "var(--line-soft)",
          border: "1px solid var(--line-soft)",
          borderRadius: 12,
          overflow: "hidden",
          marginBottom: 24,
        }}
      >
        <SummaryCell
          label="Open value (mark)"
          value={fmt$(totalMark)}
          aux={`from ${fmt$(totalCost)} cost`}
        />
        <SummaryCell
          label="Unrealized P&L"
          value={(totalMtm >= 0 ? "+" : "") + fmt$(totalMtm)}
          valueClass={totalMtm >= 0 ? "up" : "dn"}
          aux={totalCost > 0 ? fmtPct((totalMtm / totalCost) * 100, 1, true) : "—"}
        />
        <SummaryCell
          label="Today realized"
          value={(settledPnl >= 0 ? "+" : "") + fmt$(settledPnl)}
          valueClass={settledPnl >= 0 ? "up" : "dn"}
          aux={`${settled.length} settled`}
        />
        <SummaryCell
          label="USDC balance"
          value={usdc.cents != null ? fmtUsdDollars(usdc.cents / 100) : "—"}
          aux="on-chain"
        />
        <SummaryCell
          label="In the money"
          value={`${winRate}%`}
          aux={`${itmCount} ITM / ${otmCount} OTM`}
        />
      </div>

      {/* OPEN POSITIONS */}
      <Card padding={0} style={{ marginBottom: 20 }}>
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--line-soft)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h3>Open positions</h3>
            <span className="pill">{active.length}</span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            <span>Settles 4:00 PM ET</span>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 24 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                style={{
                  height: 56,
                  background: "var(--bg-elev-2)",
                  borderRadius: 6,
                  marginBottom: 8,
                  opacity: 0.5,
                }}
              />
            ))}
          </div>
        ) : error && active.length === 0 ? (
          // Terminal error state: the on-chain read couldn't complete (e.g. an
          // RPC hang after the close). Never an infinite skeleton — show an
          // honest notice with a retry instead.
          <div style={{ padding: 36, textAlign: "center" }}>
            <p style={{ color: "var(--text-3)", fontSize: 14 }}>
              Couldn&apos;t read positions from the chain (RPC timed out).
            </p>
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: 12 }}
              onClick={() => refetch()}
            >
              Retry
            </button>
          </div>
        ) : active.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center" }}>
            <p style={{ color: "var(--text-3)", fontSize: 14 }}>
              No active positions.
            </p>
            <Link
              href="/markets"
              className="btn primary"
              style={{ marginTop: 12, display: "inline-flex", textDecoration: "none" }}
            >
              Browse markets <IconCaret size={11} />
            </Link>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Side</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th style={{ textAlign: "right" }}>Avg / Mark</th>
                <th style={{ textAlign: "right" }}>Cost</th>
                <th style={{ textAlign: "right" }}>Value</th>
                <th style={{ textAlign: "right" }}>Unrealized</th>
                <th style={{ textAlign: "right" }} title="Payout and profit if this side wins at settlement ($1 per token)">
                  If it wins
                </th>
                <th style={{ textAlign: "center" }}>Spot vs strike</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((p, i) => (
                <PositionRow key={`${p.market.address}-${p.side}-${i}`} p={p} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* SETTLED + P&L CURVE */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <Card padding={0}>
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--line-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h3>Settled (last 30 days)</h3>
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
                {redeemable.length > 0
                  ? `${redeemableTokens} winning token${redeemableTokens === 1 ? "" : "s"} redeemable for $1.00 each`
                  : "Winning tokens redeem for $1.00 each"}
              </div>
            </div>
            {redeemable.length > 0 && (
              <Button sm primary onClick={() => setRedeemTarget(redeemable)}>
                Redeem all winnings · {fmt$(redeemableTokens)}
              </Button>
            )}
          </div>
          {settled.length === 0 ? (
            <div
              style={{
                padding: 36,
                textAlign: "center",
                color: "var(--text-3)",
                fontSize: 13,
              }}
            >
              No settled positions. Once you hold a position into a market&apos;s
              4:00 PM ET settlement, it shows here — winners redeem for $1.00 per token.
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Contract</th>
                  <th>Side</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Close</th>
                  <th>Outcome</th>
                  <th style={{ textAlign: "right" }}>P&L</th>
                  <th style={{ textAlign: "right", paddingRight: 18 }}></th>
                </tr>
              </thead>
              <tbody>
                {settled.map((p, i) => {
                  const ticker = p.market.ticker as Ticker;
                  const won = p.market.outcome === p.side;
                  const payout = won ? p.quantity : 0;
                  const cost = p.entryPrice != null ? (p.entryPrice * p.quantity) / 100 : null;
                  const pnl = cost != null ? payout - cost : null;
                  const close =
                    p.market.settlementPrice != null
                      ? p.market.settlementPrice / 100
                      : null;
                  const date = p.market.settlementTs
                    ? new Date(p.market.settlementTs * 1000).toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric" },
                      )
                    : "—";
                  return (
                    <tr key={`${p.market.address}-${p.side}-${i}-settled`}>
                      <td className="mono" style={{ color: "var(--text-3)", fontSize: 12 }}>
                        {date}
                      </td>
                      <td>
                        <span style={{ fontWeight: 500 }}>{ticker}</span>{" "}
                        <IconCaret
                          size={9}
                          style={{ verticalAlign: "middle", color: "var(--accent)" }}
                        />{" "}
                        <span className="num">${(p.market.strike / 100).toFixed(2)}</span>
                      </td>
                      <td
                        className={p.side === "yes" ? "up" : "dn"}
                        style={{
                          fontFamily: "var(--mono)",
                          textTransform: "uppercase",
                          fontSize: 12,
                        }}
                      >
                        {p.side}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {p.quantity}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {close != null ? fmt$(close) : "—"}
                      </td>
                      <td>
                        {won ? (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              color: "var(--up)",
                              fontSize: 12,
                            }}
                          >
                            <IconCheckCircle size={12} /> Win
                          </span>
                        ) : (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              color: "var(--down)",
                              fontSize: 12,
                            }}
                          >
                            <IconXCircle size={12} /> Loss
                          </span>
                        )}
                      </td>
                      <td
                        className={pnl == null ? "num" : pnl >= 0 ? "up num" : "dn num"}
                        style={{ textAlign: "right" }}
                      >
                        {pnl != null ? `${pnl >= 0 ? "+" : ""}${fmt$(pnl)}` : "—"}
                      </td>
                      <td style={{ textAlign: "right", paddingRight: 18 }}>
                        {won ? (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setRedeemTarget([p])}
                          >
                            Redeem
                          </button>
                        ) : (
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--text-3)",
                              fontFamily: "var(--mono)",
                            }}
                          >
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card padding={20}>
          <SectionTitle>30-day P&L curve</SectionTitle>
          <PnlCurve settled={settled} />
          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <SummaryCellInline label="Open positions" value={active.length.toString()} />
            <SummaryCellInline label="In the money" value={`${winRate}%`} />
            <SummaryCellInline
              label="Realized 30d"
              value={fmt$(settledPnl)}
              tone={settledPnl >= 0 ? "up" : "dn"}
            />
            <SummaryCellInline
              label="Unrealized"
              value={fmt$(totalMtm)}
              tone={totalMtm >= 0 ? "up" : "dn"}
            />
          </div>
        </Card>
      </div>

      {redeemTarget && (
        <RedeemConfirmationModal
          positions={redeemTarget}
          onClose={() => setRedeemTarget(null)}
          onComplete={() => {
            setRedeemTarget(null);
            refetch();
          }}
        />
      )}
    </div>
  );
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

function SummaryCellInline({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "dn";
}) {
  const bg =
    tone === "up" ? "var(--up-soft)" : tone === "dn" ? "var(--down-soft)" : "var(--bg-elev-2)";
  const color = tone === "up" ? "var(--up)" : tone === "dn" ? "var(--down)" : "var(--text)";
  return (
    <div style={{ padding: 12, background: bg, borderRadius: 6 }}>
      <div className="label" style={tone ? { color } : undefined}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 18, marginTop: 4, color }}>
        {value}
      </div>
    </div>
  );
}

/**
 * One open-position row. Reads the REAL oracle spot for this ticker and shows
 * cost/value/unrealized only when the basis is known; otherwise "—".
 */
function PositionRow({ p }: { p: Position }) {
  const ticker = p.market.ticker as Ticker;
  const { spotUsd } = useSpotPrice(ticker);
  const spotDollars = spotUsd; // number | null
  const strikeDollars = p.market.strike / 100;
  // ITM = the market currently prices THIS side above 50¢ (favored to win at
  // settlement). Same basis as the portfolio "In the money" stat so the labels
  // never contradict. The spot-vs-strike mini-chart shows the underlying.
  const itm = p.currentPrice != null ? p.currentPrice > 50 : null;
  const cost = p.entryPrice != null ? (p.entryPrice * p.quantity) / 100 : null;
  const value = p.currentPrice != null ? (p.currentPrice * p.quantity) / 100 : null;
  const mtm = cost != null && value != null ? value - cost : null;
  const mtmPct = mtm != null && cost != null && cost > 0 ? (mtm / cost) * 100 : null;
  // Settlement view: each token pays $1 if this side wins. Profit-if-wins is
  // gross of the (already-paid) entry fee.
  const payoutIfWin = p.quantity;
  const profitIfWin = cost != null ? payoutIfWin - cost : null;

  return (
    <tr
      className="row-hover"
      style={{ cursor: "pointer" }}
      onClick={() => {
        window.location.href = `/trade/${ticker}/${p.market.strike}`;
      }}
    >
      <td>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>{ticker}</span>
          <IconCaret size={11} style={{ color: "var(--accent)", alignSelf: "center" }} />
          <span className="num">${strikeDollars.toFixed(2)}</span>
          {itm != null &&
            (itm ? (
              <StrikePill tone="atm">ITM</StrikePill>
            ) : (
              <StrikePill>OTM</StrikePill>
            ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
          {TICKER_NAME[ticker]} · settles today
        </div>
      </td>
      <td>
        <span
          className={p.side === "yes" ? "up mono" : "dn mono"}
          style={{ textTransform: "uppercase", fontWeight: 600 }}
        >
          {p.side}
        </span>
      </td>
      <td className="num" style={{ textAlign: "right" }}>
        {p.quantity}
      </td>
      <td className="num" style={{ textAlign: "right" }}>
        <div>{p.entryPrice != null ? `${p.entryPrice}¢` : "—"}</div>
        <div style={{ color: "var(--text-3)", fontSize: 11 }}>
          {p.currentPrice != null ? `${p.currentPrice}¢` : "—"}
        </div>
      </td>
      <td className="num" style={{ textAlign: "right", color: "var(--text-3)" }}>
        {cost != null ? fmt$(cost) : "—"}
      </td>
      <td className="num" style={{ textAlign: "right" }}>
        {value != null ? fmt$(value) : "—"}
      </td>
      <td
        className={mtm == null ? "num" : mtm >= 0 ? "up num" : "dn num"}
        style={{ textAlign: "right" }}
      >
        {mtm != null ? (
          <>
            <div>{mtm >= 0 ? "+" : ""}{fmt$(mtm)}</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              {mtm >= 0 ? "+" : ""}
              {mtmPct != null ? mtmPct.toFixed(1) : "0.0"}%
            </div>
          </>
        ) : (
          <span style={{ color: "var(--text-3)" }} title="No on-chain cost basis found">
            —
          </span>
        )}
      </td>
      <td
        className="num"
        style={{ textAlign: "right" }}
        title={`Each ${p.side.toUpperCase()} token redeems for $1 if it wins at 4 PM ET settlement`}
      >
        <div style={{ color: "var(--up)" }}>{fmt$(payoutIfWin)}</div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>
          {profitIfWin != null
            ? `${profitIfWin >= 0 ? "+" : ""}${fmt$(profitIfWin)} profit`
            : "—"}
        </div>
      </td>
      <td style={{ textAlign: "center" }}>
        {spotDollars != null ? (
          <SpotStrikeMini spot={spotDollars} strike={strikeDollars} />
        ) : (
          <span style={{ color: "var(--text-3)", fontSize: 11 }}>—</span>
        )}
      </td>
      <td style={{ textAlign: "right", paddingRight: 18 }}>
        <Link
          href={`/trade/${ticker}/${p.market.strike}`}
          onClick={(e) => e.stopPropagation()}
          className="btn sm"
          style={{ textDecoration: "none" }}
        >
          Trade
        </Link>
      </td>
    </tr>
  );
}

function SpotStrikeMini({ spot, strike }: { spot: number; strike: number }) {
  const range = Math.max(Math.abs(spot - strike) * 4, strike * 0.05);
  const lo = strike - range;
  const hi = strike + range;
  const t = Math.max(0.04, Math.min(0.96, (spot - lo) / (hi - lo)));
  const w = 140;
  return (
    <div style={{ width: w, display: "inline-block" }}>
      <div
        style={{
          position: "relative",
          height: 6,
          background: "var(--bg-elev-2)",
          borderRadius: 3,
          overflow: "visible",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: -2,
            bottom: -2,
            width: 1.5,
            background: "var(--accent)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${t * 100}%`,
            top: -3,
            transform: "translateX(-50%)",
            width: 8,
            height: 12,
            background: "var(--text)",
            borderRadius: 2,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "var(--mono)",
          fontSize: 9.5,
          color: "var(--text-3)",
          marginTop: 4,
        }}
      >
        <span>{fmt$(spot, 2)}</span>
        <span style={{ color: "var(--accent)" }}>K {fmt$(strike, 0)}</span>
      </div>
    </div>
  );
}

function PnlCurve({ settled }: { settled: Position[] }) {
  // REAL cumulative realized-P&L curve from settled positions (with known
  // basis), ordered by settlement time. No synthesis: if there aren't at least
  // two settled data points we render an explicit empty state.
  const data = useMemo(() => {
    const points = settled
      .filter((p) => p.entryPrice != null && p.market.settlementTs != null)
      .map((p) => {
        const payout = p.market.outcome === p.side ? p.quantity : 0;
        const pnl = payout - (p.entryPrice! * p.quantity) / 100;
        return { ts: p.market.settlementTs!, pnl };
      })
      .sort((a, b) => a.ts - b.ts);
    let cum = 0;
    return points.map((pt) => {
      cum += pt.pnl;
      return cum;
    });
  }, [settled]);

  if (data.length < 2) {
    return (
      <div
        style={{
          padding: 24,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 12,
          fontFamily: "var(--mono)",
        }}
      >
        Not enough settled history to chart P&amp;L yet.
      </div>
    );
  }

  const W = 280;
  const H = 100;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i): [number, number] => [
    (i / (data.length - 1)) * W,
    H - ((v - min) / span) * (H - 12) - 6,
  ]);
  const d = "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L");
  const last = data[data.length - 1]!;
  const positive = last >= 0;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
        <defs>
          <linearGradient id="pnlfill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={positive ? "var(--up)" : "var(--down)"}
              stopOpacity="0.18"
            />
            <stop
              offset="100%"
              stopColor={positive ? "var(--up)" : "var(--down)"}
              stopOpacity="0"
            />
          </linearGradient>
        </defs>
        <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#pnlfill)" />
        <path
          d={d}
          fill="none"
          stroke={positive ? "var(--up)" : "var(--down)"}
          strokeWidth="1.5"
        />
        <line
          x1="0"
          x2={W}
          y1={H - (-min / span) * (H - 12) - 6}
          y2={H - (-min / span) * (H - 12) - 6}
          stroke="var(--line-soft)"
          strokeDasharray="2 2"
        />
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 4,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--text-3)",
        }}
      >
        <span>realized (settled)</span>
        <span className={positive ? "up" : "dn"}>
          {positive ? "+" : ""}${last.toFixed(0)}
        </span>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  desc,
  cta,
  onCta,
}: {
  title: string;
  desc: string;
  cta: string;
  onCta: () => void;
}) {
  return (
    <div
      style={{
        padding: "80px 32px",
        border: "1px dashed var(--line-soft)",
        borderRadius: 12,
        textAlign: "center",
        background: "var(--bg-elev)",
      }}
    >
      <CaretMark size={32} color="var(--text-4)" />
      <h3 style={{ marginTop: 18, marginBottom: 8 }}>{title}</h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-3)",
          maxWidth: 380,
          margin: "0 auto 20px",
        }}
      >
        {desc}
      </p>
      <Button primary onClick={onCta}>
        {cta}
      </Button>
    </div>
  );
}

function shortAddr(pk: string): string {
  if (pk.length <= 9) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}
