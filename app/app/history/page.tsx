"use client";

// History is wallet-specific; never pre-render at build time.
export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ExternalLink } from "lucide-react";

import {
  fmtAbsolute,
  fmtCents,
  fmtCount,
  fmtRelative,
  fmtUsdDollars,
} from "@/lib/format";
import { explorerTx } from "@/lib/explorer";
import type { HistoryEvent } from "@/lib/mock-data";
import { useUserHistory } from "@/lib/positions-client";
import { MAG7_TICKERS, type Ticker } from "@/lib/tickers";
import { useMounted } from "@/lib/use-mounted";

const PAGE_SIZE = 10;

/**
 * History page (`/history`).
 *
 * Implements §16.5:
 *   - Filter bar (date range, ticker, side, status, search)
 *   - Paginated event list
 *   - Tx-sig links → Solana explorer (new tab)
 */
export default function HistoryPage() {
  const mounted = useMounted();
  const wallet = useWallet();
  const connected = mounted && wallet.connected;
  const walletModal = useWalletModal();
  const { events, loading } = useUserHistory();

  const [ticker, setTicker] = useState<"all" | Ticker>("all");
  const [side, setSide] = useState<"all" | "yes" | "no">("all");
  const [type, setType] = useState<"all" | HistoryEvent["type"]>("all");
  const [status, setStatus] = useState<"all" | HistoryEvent["status"]>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (ticker !== "all" && ev.ticker !== ticker) return false;
      if (side !== "all" && ev.side !== side) return false;
      if (type !== "all" && ev.type !== type) return false;
      if (status !== "all" && ev.status !== status) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        if (!ev.txSig.toLowerCase().includes(q) && !ev.ticker.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [events, ticker, side, type, status, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageEvents = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (!connected) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <div className="rounded-lg border border-dashed border-border bg-surface/40 p-12 text-center">
          <p className="text-zinc-300">Connect a wallet to see your trade history.</p>
          <button
            type="button"
            onClick={() => walletModal.setVisible(true)}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Connect Wallet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="text-sm text-zinc-500">Every fill, mint, redeem, and settlement.</p>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
        <select
          value={ticker}
          onChange={(e) => {
            setTicker(e.target.value as "all" | Ticker);
            setPage(0);
          }}
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs outline-none focus:border-accent"
        >
          <option value="all">All tickers</option>
          {MAG7_TICKERS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={side}
          onChange={(e) => {
            setSide(e.target.value as "all" | "yes" | "no");
            setPage(0);
          }}
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs outline-none focus:border-accent"
        >
          <option value="all">All sides</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as "all" | HistoryEvent["type"]);
            setPage(0);
          }}
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs outline-none focus:border-accent"
        >
          <option value="all">All types</option>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
          <option value="mint_pair">Mint pair</option>
          <option value="redeem_pair">Redeem pair</option>
          <option value="redeem">Redeem</option>
          <option value="settle">Settle</option>
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as "all" | HistoryEvent["status"]);
            setPage(0);
          }}
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs outline-none focus:border-accent"
        >
          <option value="all">All statuses</option>
          <option value="filled">Filled</option>
          <option value="cancelled">Cancelled</option>
          <option value="failed">Failed</option>
        </select>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Search tx or ticker"
          className="flex-1 min-w-[140px] rounded-md border border-border bg-bg px-3 py-1.5 text-xs outline-none focus:border-accent"
        />
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="grid grid-cols-[110px_1fr_1fr_1fr_1fr_1fr_60px] gap-2 border-b border-border px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
          <span>When</span>
          <span>Type</span>
          <span>Market</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Price</span>
          <span className="text-right">Fee</span>
          <span className="text-right">Tx</span>
        </div>
        {loading ? (
          <div className="space-y-1 p-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-bg/40" />
            ))}
          </div>
        ) : pageEvents.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-500">
            {events.length === 0 ? (
              <>
                No trade history yet.{" "}
                <Link href="/markets" className="text-accent hover:underline">
                  Make your first trade
                </Link>
              </>
            ) : (
              "No events match your filters."
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {pageEvents.map((ev) => (
              <li
                key={ev.txSig + ev.ts}
                className="grid grid-cols-[110px_1fr_1fr_1fr_1fr_1fr_60px] items-center gap-2 px-4 py-2 text-xs"
              >
                <span className="text-zinc-500" title={fmtAbsolute(ev.ts)}>
                  {fmtRelative(ev.ts)}
                </span>
                <span
                  className={`font-medium ${
                    ev.status === "failed"
                      ? "text-no"
                      : ev.type === "buy"
                        ? "text-yes"
                        : ev.type === "sell"
                          ? "text-no"
                          : "text-zinc-300"
                  }`}
                >
                  {labelForType(ev.type)}
                </span>
                <Link
                  href={`/trade/${ev.ticker}/${ev.strike}`}
                  className="hover:text-accent"
                >
                  {ev.ticker} &gt; ${(ev.strike / 100).toFixed(2)}{" "}
                  {ev.side && (
                    <span className={ev.side === "yes" ? "text-yes" : "text-no"}>
                      · {ev.side === "yes" ? "Yes" : "No"}
                    </span>
                  )}
                </Link>
                <span className="text-right font-mono">{fmtCount(ev.quantity)}</span>
                <span className="text-right font-mono">{fmtCents(ev.price)}</span>
                <span className="text-right font-mono text-zinc-500">
                  {fmtUsdDollars(ev.feeCents / 100)}
                </span>
                <a
                  href={explorerTx(ev.txSig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-end gap-1 text-accent hover:underline"
                  title={ev.txSig}
                >
                  view <ExternalLink size={10} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>
            Page {page + 1} of {totalPages} — {filtered.length} events
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function labelForType(t: HistoryEvent["type"]): string {
  switch (t) {
    case "buy": return "Buy";
    case "sell": return "Sell";
    case "mint_pair": return "Mint pair";
    case "redeem_pair": return "Redeem pair";
    case "redeem": return "Redeem";
    case "settle": return "Settle";
  }
}
