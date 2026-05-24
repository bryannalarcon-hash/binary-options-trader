"use client";

import Link from "next/link";

import { fmtStockPrice, fmtCount } from "@/lib/format";
import type { Ticker } from "@/lib/tickers";

interface Props {
  ticker: Ticker;
  strike: number; // cents
  yesCents: number;
  noCents: number;
  volume: number;
  spotCents: number;
  /** True on Markets-page card — also renders probability. */
  showYesNoProb?: boolean;
  /** Renders highlighted (selected) when matching the URL strike on trade page. */
  selected?: boolean;
  /** Cents formatter (kept as prop so MarketCard can swap formatting locally). */
  formatPriceAsCents?: (cents: number) => string;
  formatProb?: (cents: number) => string;
}

/**
 * StrikeRow — one row in the per-card expanded strike list (Markets page)
 * AND in the left-rail strike list on the Trade page.
 *
 * Behavior on click: navigates to `/trade/[ticker]/[strike]`.
 */
export function StrikeRow({
  ticker,
  strike,
  yesCents,
  noCents,
  volume,
  spotCents,
  showYesNoProb,
  selected,
  formatPriceAsCents,
  formatProb,
}: Props) {
  const isAtm = Math.abs(spotCents - strike) <= 1500; // within $15
  const fmtPrice = formatPriceAsCents ?? ((c: number) => `${Math.round(c)}¢`);
  const fmtProbability = formatProb ?? ((c: number) => `${Math.round(c)}%`);

  return (
    <Link
      href={`/trade/${ticker}/${strike}`}
      className={`grid grid-cols-[1fr_1fr_1fr_1fr] items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        selected
          ? "bg-accent/10 text-accent ring-1 ring-accent/40"
          : "text-zinc-300 hover:bg-surface"
      }`}
    >
      <div className="flex items-center gap-2 font-mono">
        <span>{fmtStockPrice(strike)}</span>
        {isAtm && (
          <span className="rounded bg-accent/20 px-1 py-0.5 text-[9px] uppercase tracking-wider text-accent">
            ATM
          </span>
        )}
      </div>
      <div className="text-right">
        <span className="font-mono text-yes">{fmtPrice(yesCents)}</span>
        {showYesNoProb && (
          <span className="ml-1 text-[10px] text-zinc-500">
            = {fmtProbability(yesCents)}
          </span>
        )}
      </div>
      <div className="text-right">
        <span className="font-mono text-no">{fmtPrice(noCents)}</span>
        {showYesNoProb && (
          <span className="ml-1 text-[10px] text-zinc-500">
            = {fmtProbability(noCents)}
          </span>
        )}
      </div>
      <div className="text-right font-mono text-xs text-zinc-500">
        {fmtCount(volume)}
      </div>
    </Link>
  );
}
