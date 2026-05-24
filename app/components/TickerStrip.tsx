"use client";

import Link from "next/link";

import { changePctForTicker, spotForTicker } from "@/lib/mock-data";
import { fmtPctChange, fmtStockPrice } from "@/lib/format";
import { MAG7_TICKERS, type Ticker } from "@/lib/tickers";

/**
 * TickerStrip — animated row of MAG7 last-prices on the Landing page.
 * Per §16.1: each chip links to `/markets#<TICKER>`.
 *
 * The animation is a CSS-only horizontal scroll; the row is duplicated so the
 * marquee loops seamlessly.
 */
export function TickerStrip() {
  const data: { ticker: Ticker; price: number; change: number }[] = MAG7_TICKERS.map(
    (t) => ({
      ticker: t,
      price: spotForTicker(t),
      change: changePctForTicker(t),
    }),
  );

  return (
    <div className="relative overflow-hidden border-y border-border bg-bg/50">
      <div className="flex animate-[meridian-scroll_45s_linear_infinite] gap-8 whitespace-nowrap py-3">
        {[...data, ...data, ...data].map((d, i) => (
          <Link
            key={`${d.ticker}-${i}`}
            href={`/markets#${d.ticker}`}
            className="inline-flex items-baseline gap-2 px-4 text-sm"
          >
            <span className="font-semibold tracking-tight text-zinc-100">
              {d.ticker}
            </span>
            <span className="font-mono text-zinc-300">{fmtStockPrice(d.price)}</span>
            <span
              className={`font-mono text-xs ${d.change >= 0 ? "text-yes" : "text-no"}`}
            >
              {fmtPctChange(d.change)}
            </span>
          </Link>
        ))}
      </div>
      <style jsx>{`
        @keyframes meridian-scroll {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-33.333%);
          }
        }
      `}</style>
    </div>
  );
}
