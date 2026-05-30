"use client";

// History is wallet-specific; never pre-render at build time.
export const dynamic = "force-dynamic";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletConnectModal } from "@/components/WalletConnectModal";

import {
  Button,
  Card,
  EmptyState,
  IconCheckCircle,
  IconExt,
  IconRefresh,
  IconXCircle,
  Label,
  fmt$,
} from "@/components/caret";
import { explorerTx } from "@/lib/explorer";
import { fmtUsdDollars } from "@/lib/format";
import { useUserHistory, type HistoryEvent } from "@/lib/positions-client";
import { readTradeLog, subscribeTradeLog, type TradeLogEntry } from "@/lib/trade-log";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";
import { useMounted, useWalletReady } from "@/lib/use-mounted";

type Tab = "trades" | "settled" | "redemptions" | "actions";

/**
 * History — the user's plain-language activity log.
 *
 * Approachable-retail redesign: a calm, scannable feed of what happened
 * (Bought Yes / Sold / Redeemed / Settled), which market in plain English
 * ("Apple above $230"), how much in shares + dollars, when, and a clearly
 * labelled link to the on-chain transaction. ALL data hooks and on-chain reads
 * are preserved unchanged:
 *   - useUserHistory (real on-chain events; honest loading/empty)
 *   - useActionLog (local client-side trade-log)
 *   - explorerTx links + CSV export (unchanged math/format)
 */
export default function HistoryPage() {
  const mounted = useMounted();
  const ready = useWalletReady();
  const wallet = useWallet();
  const [connectOpen, setConnectOpen] = useState(false);
  const connected = mounted && wallet.connected;
  const { events, loading } = useUserHistory();
  const [tab, setTab] = useState<Tab>("trades");
  const [refreshKey, setRefreshKey] = useState(0);
  void refreshKey;
  const actionLog = useActionLog();

  const trades = useMemo(
    () => events.filter((e) => e.type === "buy" || e.type === "sell"),
    [events],
  );
  const settled = useMemo(
    () => events.filter((e) => e.type === "settle"),
    [events],
  );
  const redemptions = useMemo(
    () => events.filter((e) => e.type === "redeem" || e.type === "redeem_pair"),
    [events],
  );

  if (!ready) {
    return (
      <div className="page" style={{ maxWidth: 820 }}>
        <h2 style={{ marginBottom: 24 }}>Activity</h2>
        <div style={{ color: "var(--text-3)", fontSize: 13 }}>Connecting wallet…</div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="page" style={{ maxWidth: 820 }}>
        <h2 style={{ marginBottom: 24 }}>Activity</h2>
        <EmptyState
          title="Connect a wallet to see your activity"
          desc="Every buy, sell, settlement, and redemption you make is signed by your wallet and recorded on-chain — it all shows up here."
          cta="Connect Wallet"
          onCta={() => setConnectOpen(true)}
        />
        <WalletConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      </div>
    );
  }

  function handleExportCsv() {
    const rows = events;
    if (rows.length === 0) return;
    const header = [
      "timestamp",
      "type",
      "ticker",
      "strike",
      "side",
      "quantity",
      "price",
      "fee",
      "status",
      "tx_sig",
    ];
    const lines: string[] = [header.join(",")];
    for (const ev of rows) {
      const cells = [
        new Date(ev.ts).toISOString(),
        ev.type,
        ev.ticker,
        (ev.strike / 100).toFixed(2),
        ev.side ?? "",
        String(ev.quantity),
        (ev.price / 100).toFixed(2),
        (ev.feeCents / 100).toFixed(2),
        ev.status,
        ev.txSig,
      ];
      lines.push(
        cells
          .map((c) => {
            const s = String(c);
            if (s.includes(",") || s.includes('"') || s.includes("\n")) {
              return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
          })
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `meridian-history-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "trades", label: "Buys & sells", count: trades.length },
    { id: "settled", label: "Settled", count: settled.length },
    { id: "redemptions", label: "Redeemed", count: redemptions.length },
    { id: "actions", label: "My activity", count: actionLog.length },
  ];

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      {/* HEADER ───────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 22,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <Label>
            Connected{wallet.publicKey ? ` · ${shortAddr(wallet.publicKey.toBase58())}` : ""}
          </Label>
          <h2 style={{ marginTop: 6 }}>Your activity</h2>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6 }}>
            Everything you&apos;ve done — each item links to its transaction on the Solana explorer.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="btn"
            onClick={() => setRefreshKey((k) => k + 1)}
            aria-label="Refresh activity"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <IconRefresh size={13} /> Refresh
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleExportCsv}
            disabled={events.length === 0}
            aria-label="Download your activity as a CSV file"
          >
            Download CSV
          </button>
        </div>
      </div>

      {/* TABS — plain-language filters, no jargon. */}
      <div className="hist-tabs" role="tablist" aria-label="Activity filters">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            <span className="hist-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {/* FEED ─────────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        {loading && events.length === 0 ? (
          <LoadingFeed />
        ) : tab === "trades" ? (
          <TradesFeed rows={trades} />
        ) : tab === "settled" ? (
          <SettledFeed rows={settled} />
        ) : tab === "redemptions" ? (
          <RedemptionsFeed rows={redemptions} />
        ) : (
          <ActionFeed rows={actionLog} />
        )}
      </div>

      {/* Plain <style> (not styled-jsx) keeps this independent of build plugins.
          Tabs scroll horizontally on narrow screens; activity rows collapse from
          a single line into a stacked layout under 600px so nothing overflows. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .hist-tabs {
          display: flex;
          gap: 4px;
          overflow-x: auto;
          border-bottom: 1px solid var(--line-soft);
          scrollbar-width: none;
        }
        .hist-tabs::-webkit-scrollbar { display: none; }
        .hist-tabs button {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          background: none;
          border: 0;
          border-bottom: 2px solid transparent;
          color: var(--text-3);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
        }
        .hist-tabs button:hover { color: var(--text-2); }
        .hist-tabs button.on { color: var(--text); border-bottom-color: var(--accent); }
        .hist-tab-count {
          font-family: var(--mono);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          color: var(--text-3);
          background: var(--bg-elev-2);
          border-radius: 999px;
          padding: 1px 7px;
          min-width: 20px;
          text-align: center;
        }
        .hist-tabs button.on .hist-tab-count { color: var(--text-2); }

        .hist-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .hist-row {
          display: grid;
          grid-template-columns: 36px minmax(0, 1fr) auto auto;
          align-items: center;
          gap: 14px;
          background: var(--bg-elev);
          border: 1px solid var(--line-soft);
          border-radius: var(--r-lg);
          padding: 14px 16px;
        }
        .hist-row .hist-amount { text-align: right; }
        .hist-row .hist-link { justify-self: end; }
        @media (max-width: 600px) {
          .hist-row {
            grid-template-columns: 36px minmax(0, 1fr) auto;
            row-gap: 10px;
          }
          .hist-row .hist-amount {
            grid-column: 2 / 4;
            text-align: left;
          }
          .hist-row .hist-link {
            grid-column: 1 / 4;
            justify-self: start;
          }
        }
      `,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared row primitives — a calm activity feed (not a dense table).
// ---------------------------------------------------------------------------

/** A single activity row: icon · what happened + market · amount · tx link. */
function ActivityRow({
  icon,
  title,
  sub,
  amount,
  amountAux,
  amountTone,
  link,
}: {
  icon: ReactNode;
  title: ReactNode;
  sub: ReactNode;
  amount?: ReactNode;
  amountAux?: ReactNode;
  amountTone?: "up" | "dn";
  link: ReactNode;
}) {
  const amountColor =
    amountTone === "up" ? "var(--up)" : amountTone === "dn" ? "var(--down)" : "var(--text)";
  return (
    <div className="hist-row">
      {icon}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)" }}>{title}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 2 }}>{sub}</div>
      </div>
      {amount != null ? (
        <div className="hist-amount">
          <div
            className="num"
            style={{ fontSize: 15, fontWeight: 600, color: amountColor, lineHeight: 1.2 }}
          >
            {amount}
          </div>
          {amountAux != null && (
            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{amountAux}</div>
          )}
        </div>
      ) : (
        <div className="hist-amount" />
      )}
      <div className="hist-link">{link}</div>
    </div>
  );
}

/** Small circular badge that carries the row's meaning (bought / sold / etc.). */
function RowBadge({ tone, label }: { tone: "up" | "dn" | "accent" | "muted"; label: string }) {
  const map = {
    up: { bg: "var(--up-soft)", fg: "var(--up)" },
    dn: { bg: "var(--down-soft)", fg: "var(--down)" },
    accent: { bg: "var(--accent-soft)", fg: "var(--accent)" },
    muted: { bg: "var(--bg-elev-2)", fg: "var(--text-2)" },
  } as const;
  const c = map[tone];
  return (
    <div
      aria-hidden
      style={{
        width: 36,
        height: 36,
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      {label}
    </div>
  );
}

/** "View on explorer" link — clearly labelled, accessible, opens the tx. */
function ExplorerLink({ sig }: { sig: string }) {
  if (!sig) {
    return <span style={{ color: "var(--text-4)", fontSize: 12 }}>—</span>;
  }
  return (
    <a
      href={explorerTx(sig)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View transaction ${shortSig(sig)} on the Solana explorer`}
      title="View on Solana explorer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12.5,
        color: "var(--text-2)",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      View
      <IconExt size={12} />
    </a>
  );
}

/** Loading placeholder — calm skeleton rows, never an infinite spinner. */
function LoadingFeed() {
  return (
    <div className="hist-list">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 70,
            background: "var(--bg-elev)",
            border: "1px solid var(--line-soft)",
            borderRadius: "var(--r-lg)",
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

/** Honest empty state for a feed tab. */
function FeedEmpty({ children }: { children: ReactNode }) {
  return (
    <Card style={{ textAlign: "center", padding: "44px 32px" }}>
      <p
        style={{
          color: "var(--text-3)",
          fontSize: 13.5,
          lineHeight: 1.6,
          maxWidth: 440,
          margin: "0 auto",
        }}
      >
        {children}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Copy helpers — translate on-chain jargon into plain English.
// ---------------------------------------------------------------------------

/** "AAPL @ $230 (yes)" → "Apple above $230" / "Apple below $230". */
function marketName(ticker: Ticker, strikeCents: number, side?: string | null): string {
  const name = TICKER_NAME[ticker] ?? ticker;
  const price = `$${(strikeCents / 100).toFixed(2)}`;
  const dir = side === "no" ? "below" : "above";
  return `${name} ${dir} ${price}`;
}

/** Human time, e.g. "May 30, 2:14 PM". */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Buys & sells.
// ---------------------------------------------------------------------------

function TradesFeed({ rows }: { rows: HistoryEvent[] }) {
  if (rows.length === 0) {
    return <FeedEmpty>No buys or sells yet. When you place a trade, it shows up here.</FeedEmpty>;
  }
  return (
    <div className="hist-list">
      {rows.map((f, i) => {
        const bought = f.type === "buy";
        const sideLabel = f.side === "no" ? "No" : "Yes";
        const action = bought ? `Bought ${sideLabel}` : `Sold ${sideLabel}`;
        const value = (f.price * f.quantity) / 100;
        return (
          <ActivityRow
            key={`${f.txSig}-${i}`}
            icon={<RowBadge tone={bought ? "up" : "dn"} label={bought ? "B" : "S"} />}
            title={
              <>
                {action} · {marketName(f.ticker, f.strike, f.side)}
              </>
            }
            sub={
              <>
                {plural(f.quantity, "share")} at {f.price}¢ · {fmtTime(f.ts)}
                {f.feeCents > 0 && <> · fee {fmtUsdDollars(f.feeCents / 100)}</>}
              </>
            }
            amount={fmt$(value)}
            amountAux={bought ? "you paid" : "you got"}
            link={<ExplorerLink sig={f.txSig} />}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settled markets.
// ---------------------------------------------------------------------------

function SettledFeed({ rows }: { rows: HistoryEvent[] }) {
  if (rows.length === 0) {
    return (
      <FeedEmpty>
        Nothing has settled yet. Markets close at 4:00&nbsp;PM&nbsp;ET — once one you held settles,
        the outcome shows here.
      </FeedEmpty>
    );
  }
  return (
    <div className="hist-list">
      {rows.map((s, i) => {
        // Any side on a settle row marks the winning outcome of that market.
        const decided = s.side === "yes" || s.side === "no";
        const winner = s.side === "no" ? "No" : "Yes";
        const value = (s.price * s.quantity) / 100;
        return (
          <ActivityRow
            key={`${s.txSig}-${i}`}
            icon={
              decided ? (
                <div
                  aria-hidden
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    background: "var(--up-soft)",
                    color: "var(--up)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <IconCheckCircle size={18} />
                </div>
              ) : (
                <div
                  aria-hidden
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    background: "var(--bg-elev-2)",
                    color: "var(--text-2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <IconXCircle size={18} />
                </div>
              )
            }
            title={<>Market settled · {marketName(s.ticker, s.strike, s.side)}</>}
            sub={
              <>
                {decided ? `${winner} won` : "Outcome decided"} by the Pyth price oracle ·{" "}
                {new Date(s.ts).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </>
            }
            amount={value > 0 ? fmt$(value) : undefined}
            amountAux={value > 0 ? "your payout" : undefined}
            amountTone={value > 0 ? "up" : undefined}
            link={<ExplorerLink sig={s.txSig} />}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Redemptions.
// ---------------------------------------------------------------------------

function RedemptionsFeed({ rows }: { rows: HistoryEvent[] }) {
  if (rows.length === 0) {
    return (
      <FeedEmpty>
        You haven&apos;t redeemed anything yet. Winning shares redeem for $1.00 each after a market
        settles.
      </FeedEmpty>
    );
  }
  return (
    <div className="hist-list">
      {rows.map((r, i) => {
        const received = (r.price * r.quantity) / 100;
        const isWin = r.type === "redeem";
        return (
          <ActivityRow
            key={`${r.txSig}-${i}`}
            icon={<RowBadge tone="up" label="$" />}
            title={
              <>
                Redeemed {isWin ? "winnings" : "pair"} · {marketName(r.ticker, r.strike, r.side)}
              </>
            }
            sub={
              <>
                Turned in {plural(r.quantity, "share")} · {fmtTime(r.ts)}
              </>
            }
            amount={<>+{fmt$(received)}</>}
            amountAux="USDC received"
            amountTone="up"
            link={<ExplorerLink sig={r.txSig} />}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local action log (client-side, submitted → confirmed/failed).
// ---------------------------------------------------------------------------

/**
 * Subscribe to the local client-side action log (trade-log.ts). SSR-safe:
 * starts empty server-side, hydrates from localStorage on the client.
 */
function useActionLog(): TradeLogEntry[] {
  const [log, setLog] = useState<TradeLogEntry[]>([]);
  useEffect(() => {
    setLog(readTradeLog());
    return subscribeTradeLog(() => setLog(readTradeLog()));
  }, []);
  return log;
}

const ACTION_VERB: Record<string, string> = {
  buy: "Bought",
  sell: "Sold",
  mint_pair: "Minted pair",
  redeem_pair: "Redeemed pair",
  redeem: "Redeemed",
  cancel: "Cancelled order",
};

const STATUS_COPY: Record<string, { label: string; tone: "up" | "dn" | "muted" }> = {
  confirmed: { label: "Confirmed", tone: "up" },
  failed: { label: "Failed", tone: "dn" },
  submitted: { label: "Submitted", tone: "muted" },
};

function ActionFeed({ rows }: { rows: TradeLogEntry[] }) {
  if (rows.length === 0) {
    return (
      <FeedEmpty>
        This is your live activity log on this device. Submit a trade and you&apos;ll see it move
        from “submitted” to “confirmed” here, with a link to the transaction.
      </FeedEmpty>
    );
  }
  return (
    <div className="hist-list">
      {rows.map((e, i) => {
        const status = STATUS_COPY[e.status] ?? { label: e.status, tone: "muted" as const };
        const verb = ACTION_VERB[e.action] ?? e.action;
        const sideLabel = e.side === "no" ? "No" : e.side === "yes" ? "Yes" : "";
        const action = sideLabel ? `${verb} ${sideLabel}` : verb;
        const where =
          e.strike > 0 ? marketName(e.ticker, e.strike, e.side) : (TICKER_NAME[e.ticker] ?? e.ticker);
        const time = new Date(e.ts).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        });
        return (
          <ActivityRow
            key={`${e.ts}-${i}`}
            icon={
              <RowBadge
                tone={status.tone === "muted" ? "accent" : status.tone}
                label={status.tone === "dn" ? "!" : status.tone === "up" ? "✓" : "·"}
              />
            }
            title={
              <>
                {action} · {where}
              </>
            }
            sub={
              <span title={e.error ?? undefined}>
                {[
                  e.priceCents != null ? `${e.priceCents}¢` : null,
                  e.qty ? plural(e.qty, "share") : null,
                  time,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            }
            amount={
              <span style={{ color: statusToColor(status.tone), fontSize: 13, fontWeight: 600 }}>
                {status.label}
              </span>
            }
            link={<ExplorerLink sig={e.txSig ?? ""} />}
          />
        );
      })}
    </div>
  );
}

function statusToColor(tone: "up" | "dn" | "muted"): string {
  return tone === "up" ? "var(--up)" : tone === "dn" ? "var(--down)" : "var(--text-3)";
}

// ---------------------------------------------------------------------------
// Misc.
// ---------------------------------------------------------------------------

function shortSig(sig: string): string {
  if (!sig) return "—";
  if (sig.length <= 10) return sig;
  return `${sig.slice(0, 4)}…${sig.slice(-4)}`;
}

function shortAddr(pk: string): string {
  if (!pk) return "";
  if (pk.length <= 10) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}
