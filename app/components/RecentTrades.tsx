"use client";

import { ExternalLink } from "lucide-react";

import { fmtCents, fmtCount, fmtRelative } from "@/lib/format";
import type { RecentTrade } from "@/lib/mock-data";
import { explorerTx } from "@/lib/explorer";

interface Props {
  trades: RecentTrade[];
}

/**
 * Recent trades tape (right column on Trade page).
 * Click row → opens Solana explorer in new tab.
 */
export function RecentTrades({ trades }: Props) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Recent trades</h2>
      </div>
      <div className="max-h-72 overflow-y-auto">
        <div className="grid grid-cols-[80px_1fr_1fr_1fr] gap-2 border-b border-border/60 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
          <span>Time</span>
          <span>Side</span>
          <span className="text-right">Price</span>
          <span className="text-right">Size</span>
        </div>
        {trades.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-zinc-500">
            No trades yet.
          </p>
        )}
        {trades.map((t, i) => (
          <a
            key={`${t.txSig}-${i}`}
            href={explorerTx(t.txSig)}
            target="_blank"
            rel="noopener noreferrer"
            className="grid grid-cols-[80px_1fr_1fr_1fr] items-center gap-2 px-4 py-1.5 text-xs transition-colors hover:bg-bg/60"
          >
            <span className="text-zinc-500">{fmtRelative(t.ts)}</span>
            <span
              className={`font-medium ${t.side === "yes" ? "text-yes" : "text-no"}`}
            >
              {t.side === "yes" ? "Yes" : "No"}
              <ExternalLink size={10} className="ml-1 inline opacity-50" />
            </span>
            <span className="text-right font-mono">{fmtCents(t.price)}</span>
            <span className="text-right font-mono text-zinc-300">
              {fmtCount(t.size)}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
