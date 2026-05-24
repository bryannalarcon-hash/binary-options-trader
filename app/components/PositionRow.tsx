"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { fmtCents, fmtPct, fmtUsdDollars } from "@/lib/format";
import type { MockPosition } from "@/lib/mock-data";

import { SettlementCountdown } from "./SettlementCountdown";

interface Props {
  position: MockPosition;
  /** "active" tab vs "settled" tab — controls what action button appears. */
  view: "active" | "settled";
  onRedeem?: (position: MockPosition) => void;
}

/**
 * PositionRow — one row in the Portfolio active/settled list (§16.4).
 */
export function PositionRow({ position, view, onRedeem }: Props) {
  const { market, side, quantity, entryPrice, currentPrice } = position;
  const sideLabel = side === "yes" ? "Yes" : "No";
  const sideClass = side === "yes" ? "text-yes" : "text-no";
  const winning = market.outcome === side;

  const unrealizedDollars = (quantity * (currentPrice - entryPrice)) / 100;
  const unrealizedPct = entryPrice > 0 ? (unrealizedDollars / ((quantity * entryPrice) / 100)) * 100 : 0;

  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <Link
            href={`/trade/${market.ticker}/${market.strike}`}
            className="text-base font-medium hover:text-accent"
          >
            {market.ticker} &gt; ${(market.strike / 100).toFixed(2)}
          </Link>
          <span className={`text-xs font-semibold uppercase tracking-wider ${sideClass}`}>
            {sideLabel}
          </span>
          {view === "settled" && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                winning ? "bg-yes/20 text-yes" : "bg-zinc-700 text-zinc-300"
              }`}
            >
              {winning ? "Won" : "Lost"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          <Field label="Qty">{quantity.toLocaleString()}</Field>
          <Field label="Entry">{fmtCents(entryPrice)}</Field>
          {view === "active" && (
            <>
              <Field label="Current">{fmtCents(currentPrice)}</Field>
              <Field label="P&L">
                <span className={unrealizedDollars >= 0 ? "text-yes" : "text-no"}>
                  {fmtUsdDollars(unrealizedDollars)} ({fmtPct(Math.abs(unrealizedPct))}{" "}
                  {unrealizedDollars >= 0 ? "↑" : "↓"})
                </span>
              </Field>
            </>
          )}
          {view === "settled" && (
            <>
              <Field label="Settled at">
                {market.settlementPrice != null
                  ? `$${(market.settlementPrice / 100).toFixed(2)}`
                  : "—"}
              </Field>
              <Field label="Payout">
                <span className={winning ? "text-yes" : "text-zinc-500"}>
                  {fmtUsdDollars(winning ? quantity : 0)}
                </span>
              </Field>
            </>
          )}
        </div>
        {view === "active" && <SettlementCountdown />}
      </div>

      <div className="flex flex-col items-end justify-between gap-2">
        {view === "active" ? (
          <Link
            href={`/trade/${market.ticker}/${market.strike}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-zinc-200 hover:bg-bg/60"
          >
            Sell <ChevronRight size={12} />
          </Link>
        ) : winning ? (
          <button
            type="button"
            onClick={() => onRedeem?.(position)}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90"
          >
            Redeem
          </button>
        ) : (
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            No payout
          </span>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="font-mono text-zinc-200">{children}</p>
    </div>
  );
}
