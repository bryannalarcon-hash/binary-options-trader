"use client";

// History is wallet-specific; never pre-render at build time.
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletConnectModal } from "@/components/WalletConnectModal";

import {
  Button,
  Card,
  EmptyState,
  IconCaret,
  IconCheckCircle,
  IconExt,
  IconFilter,
  IconRefresh,
  IconXCircle,
  Label,
  Seg,
  fmt$,
} from "@/components/caret";
import { explorerTx } from "@/lib/explorer";
import { fmtUsdDollars } from "@/lib/format";
import { useUserHistory, type HistoryEvent } from "@/lib/positions-client";
import { readTradeLog, subscribeTradeLog, type TradeLogEntry } from "@/lib/trade-log";
import { useMounted, useWalletReady } from "@/lib/use-mounted";

type Tab = "trades" | "settled" | "redemptions" | "actions";

/**
 * History — caret-styled, real on-chain events from useUserHistory.
 * CSV export preserved.
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
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>History</h2>
        <div style={{ color: "var(--text-3)", fontSize: 13, fontFamily: "var(--mono)" }}>
          Connecting wallet…
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 24 }}>History</h2>
        <EmptyState
          title="Connect a wallet to see your trade history"
          desc="Every fill, settlement, and redemption — signed by your wallet, indexed on-chain."
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
          <Label>Connected · history</Label>
          <h2 style={{ marginTop: 6 }}>History</h2>
          <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6 }}>
            All trades, settlements, and redemptions — on-chain
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Seg
            options={[
              { value: "1d", label: "1D" },
              { value: "7d", label: "7D" },
              { value: "30d", label: "30D" },
              { value: "all", label: "All" },
            ]}
            value="all"
            onChange={() => {}}
          />
          <Button leftIcon={<IconRefresh size={13} />} onClick={() => setRefreshKey((k) => k + 1)}>
            Refresh
          </Button>
          <Button onClick={handleExportCsv} disabled={events.length === 0}>
            Export CSV
          </Button>
        </div>
      </div>

      <Card padding={0}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingRight: 18,
          }}
        >
          <div className="tabs" style={{ flex: 1, paddingLeft: 14 }}>
            <button
              type="button"
              className={tab === "trades" ? "on" : ""}
              onClick={() => setTab("trades")}
            >
              Trades · {trades.length}
            </button>
            <button
              type="button"
              className={tab === "settled" ? "on" : ""}
              onClick={() => setTab("settled")}
            >
              Settlements · {settled.length}
            </button>
            <button
              type="button"
              className={tab === "redemptions" ? "on" : ""}
              onClick={() => setTab("redemptions")}
            >
              Redemptions · {redemptions.length}
            </button>
            <button
              type="button"
              className={tab === "actions" ? "on" : ""}
              onClick={() => setTab("actions")}
              title="Local client-side action log (submitted/confirmed/failed)"
            >
              My actions · {actionLog.length}
            </button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--text-3)",
            }}
          >
            <IconFilter size={11} /> Filter
          </div>
        </div>

        {loading && events.length === 0 ? (
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: "var(--text-3)",
              fontSize: 13,
            }}
          >
            Loading history…
          </div>
        ) : tab === "trades" ? (
          <TradesTable rows={trades} />
        ) : tab === "settled" ? (
          <SettledTable rows={settled} />
        ) : tab === "redemptions" ? (
          <RedemptionsTable rows={redemptions} />
        ) : (
          <ActionLogTable rows={actionLog} />
        )}
      </Card>
    </div>
  );
}

function TradesTable({ rows }: { rows: HistoryEvent[] }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 36,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        No trades yet.
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Contract</th>
          <th style={{ textAlign: "right" }}>Price</th>
          <th style={{ textAlign: "right" }}>Qty</th>
          <th style={{ textAlign: "right" }}>Value</th>
          <th style={{ textAlign: "right" }}>Fee</th>
          <th style={{ textAlign: "right", paddingRight: 18 }}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f, i) => (
          <tr key={`${f.txSig}-${i}`} className="row-hover">
            <td className="mono" style={{ color: "var(--text-3)" }}>
              {new Date(f.ts).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })}
            </td>
            <td>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  padding: "3px 6px",
                  borderRadius: 4,
                  background:
                    f.type === "buy" ? "var(--up-soft)" : "var(--down-soft)",
                  color: f.type === "buy" ? "var(--up)" : "var(--down)",
                }}
              >
                {f.type} {f.side ?? ""}
              </span>
            </td>
            <td>
              <span style={{ fontWeight: 500 }}>{f.ticker}</span>{" "}
              <IconCaret
                size={10}
                style={{ verticalAlign: "middle", color: "var(--accent)" }}
              />{" "}
              <span className="num">${(f.strike / 100).toFixed(2)}</span>
            </td>
            <td className="num" style={{ textAlign: "right" }}>
              {f.price}¢
            </td>
            <td className="num" style={{ textAlign: "right" }}>
              {f.quantity}
            </td>
            <td className="num" style={{ textAlign: "right" }}>
              {fmt$((f.price * f.quantity) / 100)}
            </td>
            <td
              className="num"
              style={{ textAlign: "right", color: "var(--text-3)" }}
            >
              {fmtUsdDollars(f.feeCents / 100)}
            </td>
            <td style={{ textAlign: "right", paddingRight: 18 }}>
              <a
                href={explorerTx(f.txSig)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text-3)",
                  textDecoration: "none",
                }}
              >
                {shortSig(f.txSig)} <IconExt size={11} />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettledTable({ rows }: { rows: HistoryEvent[] }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 36,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        No settlements yet — markets close at 4:00 PM ET.
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Date</th>
          <th>Contract</th>
          <th>Outcome</th>
          <th style={{ textAlign: "right" }}>P&L</th>
          <th style={{ textAlign: "right", paddingRight: 18 }}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s, i) => {
          const won = s.side === "yes" || s.side === "no"; // any side indicates the outcome row
          return (
            <tr key={`${s.txSig}-${i}`}>
              <td className="mono" style={{ color: "var(--text-3)", fontSize: 12 }}>
                {new Date(s.ts).toLocaleDateString()}
              </td>
              <td>
                <span style={{ fontWeight: 500 }}>{s.ticker}</span>{" "}
                <IconCaret
                  size={10}
                  style={{ verticalAlign: "middle", color: "var(--accent)" }}
                />{" "}
                <span className="num">${(s.strike / 100).toFixed(2)}</span>
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
                    <IconCheckCircle size={12} /> Pyth settled · {s.side?.toUpperCase()} wins
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
                    <IconXCircle size={12} /> Pyth settled
                  </span>
                )}
              </td>
              <td className="num" style={{ textAlign: "right" }}>
                {fmt$((s.price * s.quantity) / 100)}
              </td>
              <td style={{ textAlign: "right", paddingRight: 18 }}>
                <a
                  href={explorerTx(s.txSig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--text-3)",
                    textDecoration: "none",
                  }}
                >
                  {shortSig(s.txSig)} <IconExt size={11} />
                </a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RedemptionsTable({ rows }: { rows: HistoryEvent[] }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 36,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        No redemptions yet.
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Time</th>
          <th>Contract</th>
          <th style={{ textAlign: "right" }}>Tokens burned</th>
          <th style={{ textAlign: "right" }}>USDC received</th>
          <th style={{ textAlign: "right", paddingRight: 18 }}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.txSig}-${i}`}>
            <td className="mono" style={{ color: "var(--text-3)" }}>
              {new Date(r.ts).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })}
            </td>
            <td>
              <span style={{ fontWeight: 500 }}>{r.ticker}</span>{" "}
              <IconCaret
                size={10}
                style={{ verticalAlign: "middle", color: "var(--accent)" }}
              />{" "}
              <span className="num">${(r.strike / 100).toFixed(2)}</span>{" "}
              {r.type === "redeem" && (
                <span
                  style={{
                    marginLeft: 8,
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--up)",
                    padding: "1px 5px",
                    border: "1px solid var(--up-line)",
                    borderRadius: 4,
                  }}
                >
                  WIN
                </span>
              )}
            </td>
            <td className="num" style={{ textAlign: "right" }}>
              {r.quantity}
            </td>
            <td className="num up" style={{ textAlign: "right" }}>
              +{fmt$((r.price * r.quantity) / 100)}
            </td>
            <td style={{ textAlign: "right", paddingRight: 18 }}>
              <a
                href={explorerTx(r.txSig)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text-3)",
                  textDecoration: "none",
                }}
              >
                {shortSig(r.txSig)} <IconExt size={11} />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

function ActionLogTable({ rows }: { rows: TradeLogEntry[] }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 36,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        No local actions logged yet — submit a trade and it appears here
        (submitted → confirmed/failed), with the on-chain tx link.
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Contract</th>
          <th style={{ textAlign: "right" }}>Price</th>
          <th style={{ textAlign: "right" }}>Qty</th>
          <th>Status</th>
          <th style={{ textAlign: "right", paddingRight: 18 }}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e, i) => {
          const statusColor =
            e.status === "confirmed"
              ? "var(--up)"
              : e.status === "failed"
                ? "var(--down)"
                : "var(--text-3)";
          return (
            <tr key={`${e.ts}-${i}`} className="row-hover">
              <td className="mono" style={{ color: "var(--text-3)" }}>
                {new Date(e.ts).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: true,
                })}
              </td>
              <td>
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {e.action} {e.side ?? ""}
                </span>
              </td>
              <td>
                <span style={{ fontWeight: 500 }}>{e.ticker}</span>
                {e.strike > 0 && (
                  <>
                    {" "}
                    <span className="num">${(e.strike / 100).toFixed(2)}</span>
                  </>
                )}
              </td>
              <td className="num" style={{ textAlign: "right" }}>
                {e.priceCents != null ? `${e.priceCents}¢` : "—"}
              </td>
              <td className="num" style={{ textAlign: "right" }}>
                {e.qty || "—"}
              </td>
              <td
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: statusColor,
                  textTransform: "uppercase",
                }}
                title={e.error ?? ""}
              >
                {e.status}
              </td>
              <td style={{ textAlign: "right", paddingRight: 18 }}>
                {e.txSig ? (
                  <a
                    href={explorerTx(e.txSig)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--text-3)",
                      textDecoration: "none",
                    }}
                  >
                    {shortSig(e.txSig)} <IconExt size={11} />
                  </a>
                ) : (
                  <span style={{ color: "var(--text-4)", fontSize: 11 }}>—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function shortSig(sig: string): string {
  if (!sig) return "—";
  if (sig.length <= 10) return sig;
  return `${sig.slice(0, 4)}…${sig.slice(-4)}`;
}
