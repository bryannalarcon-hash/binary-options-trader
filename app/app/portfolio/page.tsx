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
  fmt$,
} from "@/components/caret";
import { RedeemConfirmationModal } from "@/components/RedeemConfirmationModal";
import { fmtUsdDollars } from "@/lib/format";
import { useSpotPrice } from "@/lib/markets-client";
import { useUserPositions, type Position } from "@/lib/positions-client";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";
import { useUsdcBalance } from "@/lib/usdc";
import { useMounted, useWalletReady } from "@/lib/use-mounted";

/**
 * Portfolio — the "did I win?" moment.
 *
 * Approachable-retail redesign: calm card layout, plain language, an obvious
 * and reassuring redeem action. ALL data hooks and on-chain logic preserved:
 *   - useUserPositions (real on-chain SPL balances with mock fallback)
 *   - useUsdcBalance
 *   - buildAndSendRedeem (via RedeemConfirmationModal)
 *   - settled aggregate / redeemable set / refresh-on-error are unchanged math.
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
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>Connecting wallet…</div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>Portfolio</h2>
        <EmptyState
          title="Connect a wallet to see your positions"
          desc="Meridian is non-custodial — your funds stay in your wallet. Phantom, Solflare, and Backpack all work on Solana devnet."
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
    <div className="page" style={{ maxWidth: 920 }}>
      {/* HEADER ───────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 20,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <Label>
            Connected{wallet.publicKey ? ` · ${shortAddr(wallet.publicKey.toBase58())}` : ""}
          </Label>
          <h2 style={{ marginTop: 6 }}>Your portfolio</h2>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6 }}>
            {active.length} open · {settled.length} settled in the last 30 days
          </div>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => refetch()}
          aria-label="Refresh positions"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <IconRefresh size={13} /> Refresh
        </button>
      </div>

      {/* WINNINGS BANNER — the reassuring, obvious "you can claim this" moment.
          Calm card, not a jackpot: states the amount in plain dollars and offers
          one clear action. Renders only when there is something to redeem. */}
      {redeemable.length > 0 && (
        <RedeemBanner
          tokens={redeemableTokens}
          onRedeem={() => setRedeemTarget(redeemable)}
        />
      )}

      {/* SNAPSHOT — one calm row of plain-language numbers. P&L pairs sign + word
          + color so meaning is never color-only. */}
      <div className="pf-snap" style={{ marginBottom: 28 }}>
        <SnapCell
          label="Positions worth now"
          value={fmt$(totalMark)}
          aux={`You paid ${fmt$(totalCost)}`}
        />
        <SnapCell
          label="Up or down today"
          value={(totalMtm >= 0 ? "+" : "−") + fmt$(Math.abs(totalMtm))}
          tone={totalMtm >= 0 ? "up" : "dn"}
          aux={
            totalCost > 0
              ? `${totalMtm >= 0 ? "Up" : "Down"} ${Math.abs((totalMtm / totalCost) * 100).toFixed(1)}%`
              : "Open positions"
          }
        />
        <SnapCell
          label="Cash in wallet"
          value={usdc.cents != null ? fmtUsdDollars(usdc.cents / 100) : "—"}
          aux="USDC, on-chain"
        />
        <SnapCell
          label="Favored to win"
          value={`${winRate}%`}
          aux={`${itmCount} ahead · ${otmCount} behind`}
        />
      </div>

      {/* OPEN POSITIONS ───────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 32 }}>
        <SectionHead
          title="What you hold"
          count={active.length}
          hint="Each settles today at 4:00 PM ET"
        />

        {loading ? (
          <div className="stack" style={{ gap: 10 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                style={{
                  height: 96,
                  background: "var(--bg-elev)",
                  border: "1px solid var(--line-soft)",
                  borderRadius: "var(--r-lg)",
                  opacity: 0.5,
                }}
              />
            ))}
          </div>
        ) : error && active.length === 0 ? (
          // Terminal error state: the on-chain read couldn't complete (e.g. an
          // RPC hang). Never an infinite skeleton — an honest notice + retry.
          <Card style={{ textAlign: "center", padding: "40px 32px" }}>
            <p style={{ color: "var(--text-2)", fontSize: 14, margin: 0 }}>
              We couldn&apos;t read your positions from the chain — the network request
              timed out.
            </p>
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: 16 }}
              onClick={() => refetch()}
            >
              Try again
            </button>
          </Card>
        ) : active.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "44px 32px" }}>
            <p style={{ color: "var(--text-2)", fontSize: 14, margin: 0 }}>
              You don&apos;t hold any positions right now.
            </p>
            <Link
              href="/markets"
              className="btn primary"
              style={{
                marginTop: 16,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                textDecoration: "none",
              }}
            >
              Browse markets <IconCaret size={11} />
            </Link>
          </Card>
        ) : (
          <div className="pf-cards">
            {active.map((p, i) => (
              <OpenPositionCard key={`${p.market.address}-${p.side}-${i}`} p={p} />
            ))}
          </div>
        )}
      </section>

      {/* SETTLED ──────────────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          title="Settled"
          count={settled.length}
          hint={
            redeemable.length > 0
              ? `${redeemableTokens} winning share${redeemableTokens === 1 ? "" : "s"} ready to redeem`
              : "Winning shares redeem for $1.00 each"
          }
          action={
            redeemable.length > 0 ? (
              <Button sm primary onClick={() => setRedeemTarget(redeemable)}>
                Redeem all · {fmt$(redeemableTokens)}
              </Button>
            ) : undefined
          }
        />

        {settled.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "44px 32px" }}>
            <p
              style={{
                color: "var(--text-3)",
                fontSize: 13.5,
                lineHeight: 1.6,
                maxWidth: 460,
                margin: "0 auto",
              }}
            >
              No settled positions yet. Once you hold a position into a market&apos;s
              4:00&nbsp;PM&nbsp;ET settlement it shows here — winning shares redeem for
              $1.00 each.
            </p>
          </Card>
        ) : (
          <>
            <div className="pf-cards">
              {settled.map((p, i) => (
                <SettledPositionCard
                  key={`${p.market.address}-${p.side}-${i}-settled`}
                  p={p}
                  onRedeem={() => setRedeemTarget([p])}
                />
              ))}
            </div>

            {/* Realized P&L over the settled window — quiet, supportive, not a
                trading terminal. Only shown when there's history to plot. */}
            <Card style={{ marginTop: 16, padding: 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 12,
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <h4 style={{ margin: 0 }}>Your results over time</h4>
                <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                  Realized profit &amp; loss, last 30 days
                </span>
              </div>
              <PnlCurve settled={settled} />
            </Card>
          </>
        )}
      </section>

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

      {/* Scoped responsive rules. Uses only design tokens; collapses the snapshot
          and card grids on narrow screens so nothing overflows on mobile. Plain
          <style> (not styled-jsx) keeps this independent of build plugins. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .pf-snap {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1px;
          background: var(--line-soft);
          border: 1px solid var(--line-soft);
          border-radius: var(--r-lg);
          overflow: hidden;
        }
        .pf-cards {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
        }
        @media (max-width: 720px) {
          .pf-snap { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 600px) {
          .pf-cards { grid-template-columns: 1fr; }
        }
      `,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header / chrome
// ---------------------------------------------------------------------------
function SectionHead({
  title,
  count,
  hint,
  action,
}: {
  title: string;
  count: number;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        marginBottom: 14,
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <span className="pill">{count}</span>
        </div>
        {hint && (
          <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 4 }}>{hint}</div>
        )}
      </div>
      {action}
    </div>
  );
}

function SnapCell({
  label,
  value,
  aux,
  tone,
}: {
  label: string;
  value: string;
  aux?: string;
  tone?: "up" | "dn";
}) {
  const color = tone === "up" ? "var(--up)" : tone === "dn" ? "var(--down)" : "var(--text)";
  return (
    <div style={{ background: "var(--bg-elev)", padding: "16px 18px" }}>
      <div className="label">{label}</div>
      <div
        className="num"
        style={{ fontSize: 22, fontWeight: 600, marginTop: 6, color, lineHeight: 1.1 }}
      >
        {value}
      </div>
      {aux && (
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>{aux}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Winnings banner — the reassuring redeem prompt.
// ---------------------------------------------------------------------------
function RedeemBanner({ tokens, onRedeem }: { tokens: number; onRedeem: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        padding: "18px 20px",
        marginBottom: 24,
        background: "var(--up-soft)",
        border: "1px solid var(--up-line)",
        borderRadius: "var(--r-lg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span
          aria-hidden
          style={{ color: "var(--up)", display: "inline-flex", flexShrink: 0 }}
        >
          <IconCheckCircle size={20} />
        </span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
            You have winnings to claim
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 2 }}>
            {tokens} winning share{tokens === 1 ? "" : "s"} · worth{" "}
            <span className="num" style={{ color: "var(--up)", fontWeight: 600 }}>
              {fmt$(tokens)}
            </span>{" "}
            at $1.00 each
          </div>
        </div>
      </div>
      <button
        type="button"
        className="btn primary lg"
        onClick={onRedeem}
        style={{ flexShrink: 0 }}
      >
        Redeem {fmt$(tokens)}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open position card — what you hold, what it's worth, up/down.
// Reads the REAL oracle spot for the spot-vs-strike mini. Cost / value /
// up-down only render when the basis is known; otherwise an honest "—".
// ---------------------------------------------------------------------------
function OpenPositionCard({ p }: { p: Position }) {
  const ticker = p.market.ticker as Ticker;
  const { spotUsd } = useSpotPrice(ticker);
  const spotDollars = spotUsd; // number | null
  const strikeDollars = p.market.strike / 100;
  // ITM = the market currently prices THIS side above 50¢ (favored to win at
  // settlement). Same basis as the portfolio "Favored to win" stat so the
  // labels never contradict.
  const itm = p.currentPrice != null ? p.currentPrice > 50 : null;
  const cost = p.entryPrice != null ? (p.entryPrice * p.quantity) / 100 : null;
  const value = p.currentPrice != null ? (p.currentPrice * p.quantity) / 100 : null;
  const mtm = cost != null && value != null ? value - cost : null;
  const mtmPct = mtm != null && cost != null && cost > 0 ? (mtm / cost) * 100 : null;
  // Settlement view: each share pays $1 if this side wins.
  const payoutIfWin = p.quantity;
  const profitIfWin = cost != null ? payoutIfWin - cost : null;

  const sideUp = p.side === "yes";

  return (
    <Link
      href={`/trade/${ticker}/${p.market.strike}`}
      className="card row-hover"
      style={{
        display: "block",
        padding: 18,
        textDecoration: "none",
        color: "inherit",
      }}
    >
      {/* Title: plain-language question + side */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>
            {ticker} above ${strikeDollars.toFixed(2)}?
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>
            {TICKER_NAME[ticker]} · settles today
          </div>
        </div>
        <span
          className={`pill ${sideUp ? "up" : "dn"}`}
          style={{ flexShrink: 0 }}
        >
          {sideUp ? "Yes" : "No"}
        </span>
      </div>

      {/* Holding + value */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 12,
          marginTop: 16,
        }}
      >
        <Field label="Shares" value={`${p.quantity}`} />
        <Field label="You paid" value={cost != null ? fmt$(cost) : "—"} />
        <Field
          label="Worth now"
          value={value != null ? fmt$(value) : "—"}
          align="right"
        />
      </div>

      {/* Up/Down line — sign + word + color, so meaning is never color-only */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid var(--line-soft)",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {mtm != null ? (
          <div
            className={mtm >= 0 ? "up" : "dn"}
            style={{ display: "flex", alignItems: "baseline", gap: 8 }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {mtm >= 0 ? "Up" : "Down"}
            </span>
            <span className="num" style={{ fontSize: 15, fontWeight: 600 }}>
              {mtm >= 0 ? "+" : "−"}
              {fmt$(Math.abs(mtm))}
            </span>
            {mtmPct != null && (
              <span className="num" style={{ fontSize: 12, opacity: 0.8 }}>
                {mtm >= 0 ? "+" : "−"}
                {Math.abs(mtmPct).toFixed(1)}%
              </span>
            )}
          </div>
        ) : (
          <span
            style={{ fontSize: 12, color: "var(--text-3)" }}
            title="No on-chain cost basis found for this position"
          >
            No cost basis on chain
          </span>
        )}

        <div
          style={{ fontSize: 12, color: "var(--text-3)", textAlign: "right" }}
          title={`Each ${sideUp ? "Yes" : "No"} share redeems for $1 if it wins at 4 PM ET settlement`}
        >
          If it wins:{" "}
          <span className="num" style={{ color: "var(--up)", fontWeight: 600 }}>
            {fmt$(payoutIfWin)}
          </span>
          {profitIfWin != null && (
            <>
              {" "}
              <span className="num">
                ({profitIfWin >= 0 ? "+" : "−"}
                {fmt$(Math.abs(profitIfWin))})
              </span>
            </>
          )}
        </div>
      </div>

      {/* Spot vs strike — small, calm context */}
      {spotDollars != null && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>
              {ticker} now {fmt$(spotDollars, 2)} vs ${strikeDollars.toFixed(0)} target
            </span>
            {itm != null && (
              <span
                className={itm ? "up" : "dn"}
                style={{ fontSize: 11, fontWeight: 600 }}
              >
                {itm ? "Ahead" : "Behind"}
              </span>
            )}
          </div>
          <SpotStrikeMini spot={spotDollars} strike={strikeDollars} />
        </div>
      )}
    </Link>
  );
}

function Field({
  label,
  value,
  align = "left",
}: {
  label: string;
  value: string;
  align?: "left" | "right";
}) {
  return (
    <div style={{ textAlign: align }}>
      <div style={{ fontSize: 11, color: "var(--text-3)" }}>{label}</div>
      <div className="num" style={{ fontSize: 15, fontWeight: 500, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settled position card — winner (reassuring redeem) or honest "didn't win".
// ---------------------------------------------------------------------------
function SettledPositionCard({ p, onRedeem }: { p: Position; onRedeem: () => void }) {
  const ticker = p.market.ticker as Ticker;
  const sideUp = p.side === "yes";
  const won = p.market.outcome === p.side;
  const payout = won ? p.quantity : 0;
  const cost = p.entryPrice != null ? (p.entryPrice * p.quantity) / 100 : null;
  const pnl = cost != null ? payout - cost : null;
  const strikeDollars = p.market.strike / 100;
  const close =
    p.market.settlementPrice != null ? p.market.settlementPrice / 100 : null;
  const date = p.market.settlementTs
    ? new Date(p.market.settlementTs * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <Card style={{ padding: 18, display: "flex", flexDirection: "column" }}>
      {/* Title + outcome */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>
            {ticker} above ${strikeDollars.toFixed(2)}?
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>
            Your bet: {sideUp ? "Yes" : "No"}
            {date ? ` · settled ${date}` : ""}
            {close != null ? ` · closed ${fmt$(close)}` : ""}
          </div>
        </div>
        {won ? (
          <span
            className="pill up"
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <IconCheckCircle size={12} /> Won
          </span>
        ) : (
          <span
            className="pill"
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--text-3)",
            }}
          >
            <IconXCircle size={12} /> Didn&apos;t win
          </span>
        )}
      </div>

      {/* Result line + action */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid var(--line-soft)",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {won ? "Your result" : "Outcome"}
          </div>
          {pnl != null ? (
            <div
              className={pnl >= 0 ? "up" : "dn"}
              style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {pnl >= 0 ? "Profit" : "Loss"}
              </span>
              <span className="num" style={{ fontSize: 16, fontWeight: 600 }}>
                {pnl >= 0 ? "+" : "−"}
                {fmt$(Math.abs(pnl))}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 2 }}>
              No cost basis on chain
            </div>
          )}
        </div>

        {won ? (
          <button
            type="button"
            className="btn primary"
            onClick={onRedeem}
            aria-label={`Redeem ${p.quantity} winning shares for ${fmt$(p.quantity)}`}
          >
            Redeem {fmt$(p.quantity)}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Spot vs strike mini — calm position marker on a strike-centered track.
// ---------------------------------------------------------------------------
function SpotStrikeMini({ spot, strike }: { spot: number; strike: number }) {
  const range = Math.max(Math.abs(spot - strike) * 4, strike * 0.05);
  const lo = strike - range;
  const hi = strike + range;
  const t = Math.max(0.04, Math.min(0.96, (spot - lo) / (hi - lo)));
  return (
    <div
      style={{
        position: "relative",
        height: 6,
        background: "var(--bg-elev-2)",
        borderRadius: 3,
        overflow: "visible",
      }}
    >
      {/* strike line (center) */}
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
      {/* spot marker */}
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
  );
}

// ---------------------------------------------------------------------------
// Realized P&L curve — REAL cumulative realized P&L from settled positions
// (known basis), ordered by settlement time. No synthesis: <2 points → empty.
// ---------------------------------------------------------------------------
function PnlCurve({ settled }: { settled: Position[] }) {
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
          padding: 20,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 12.5,
        }}
      >
        Not enough settled history to chart yet — this fills in as more of your
        positions settle.
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
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: H }}
      >
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
          alignItems: "baseline",
          marginTop: 8,
          fontSize: 12,
          color: "var(--text-3)",
        }}
      >
        <span>Total realized</span>
        <span className={positive ? "up" : "dn"} style={{ fontWeight: 600 }}>
          <span className="num">
            {positive ? "+" : "−"}${Math.abs(last).toFixed(2)}
          </span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect-wallet empty state.
// ---------------------------------------------------------------------------
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
        borderRadius: "var(--r-lg)",
        textAlign: "center",
        background: "var(--bg-elev)",
      }}
    >
      <CaretMark size={32} color="var(--text-4)" />
      <h3 style={{ marginTop: 18, marginBottom: 8 }}>{title}</h3>
      <p
        style={{
          fontSize: 13.5,
          color: "var(--text-3)",
          lineHeight: 1.6,
          maxWidth: 400,
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
