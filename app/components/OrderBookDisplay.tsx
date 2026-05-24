"use client";

import { useMemo, useState } from "react";

import type { OrderBookSnapshot } from "@meridian/types";
import { fmtCents, fmtCount, fmtPct } from "@/lib/format";

interface Props {
  book: OrderBookSnapshot | null;
  loading: boolean;
  /** Called when user clicks a level — fills the trade panel's limit-price field. */
  onLevelClick?: (priceCents: number, side: "bid" | "ask") => void;
}

/**
 * OrderBookDisplay — depth ladder with Yes / No perspective toggle.
 *
 * Per IMPLEMENTATION_PLAN §7.1: same Phoenix Yes book is shown either:
 *   - Yes perspective: raw prices and sides as-is
 *   - No perspective:  flip each price as (1.00 - yes_price), swap bid/ask labels
 *
 * Click a level → caller fills its limit price input.
 */
export function OrderBookDisplay({ book, loading, onLevelClick }: Props) {
  const [perspective, setPerspective] = useState<"yes" | "no">("yes");

  // Build asks (above) descending in price, bids (below) descending in price.
  const view = useMemo(() => {
    if (!book) return null;
    if (perspective === "yes") {
      const asks = [...book.asks].sort((a, b) => b.price - a.price);
      const bids = [...book.bids].sort((a, b) => b.price - a.price);
      return { asks, bids, bestBid: bids[0]?.price ?? null, bestAsk: asks[asks.length - 1]?.price ?? null };
    }
    // No-perspective: flip prices (100 - p), and the original "ask" on Yes becomes
    // a "bid" on No (selling Yes high == buying No cheap). Swap labels accordingly.
    const flippedBids = book.asks
      .map((o) => ({ ...o, price: 100 - o.price, side: "bid" as const }))
      .sort((a, b) => b.price - a.price);
    const flippedAsks = book.bids
      .map((o) => ({ ...o, price: 100 - o.price, side: "ask" as const }))
      .sort((a, b) => b.price - a.price);
    return {
      asks: flippedAsks,
      bids: flippedBids,
      bestBid: flippedBids[0]?.price ?? null,
      bestAsk: flippedAsks[flippedAsks.length - 1]?.price ?? null,
    };
  }, [book, perspective]);

  const spread =
    view && view.bestAsk != null && view.bestBid != null
      ? view.bestAsk - view.bestBid
      : null;

  // For depth bars: max cumulative size on each side.
  const maxSize = useMemo(() => {
    if (!view) return 0;
    return Math.max(
      ...view.asks.map((a) => a.size),
      ...view.bids.map((b) => b.size),
      1,
    );
  }, [view]);

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Order book</h2>
        <div className="inline-flex rounded-md border border-border bg-bg p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setPerspective("yes")}
            className={`rounded px-2 py-1 transition-colors ${
              perspective === "yes"
                ? "bg-yes/20 text-yes"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            aria-pressed={perspective === "yes"}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => setPerspective("no")}
            className={`rounded px-2 py-1 transition-colors ${
              perspective === "no"
                ? "bg-no/20 text-no"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            aria-pressed={perspective === "no"}
          >
            No
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_1fr_1fr] gap-1 px-4 pt-3 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Prob</span>
      </div>

      {loading || !view ? (
        <div className="space-y-1 px-4 pb-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-5 animate-pulse rounded bg-bg/60"
            />
          ))}
        </div>
      ) : (
        <>
          <div className="px-4 py-2">
            {view.asks.map((o, i) => (
              <BookRow
                key={`ask-${i}`}
                color="text-no"
                bgFill="bg-no/10"
                price={o.price}
                size={o.size}
                maxSize={maxSize}
                onClick={() => onLevelClick?.(o.price, "ask")}
              />
            ))}
          </div>
          <div className="mx-4 flex items-center justify-between border-y border-border bg-bg/30 px-2 py-2 text-xs">
            <span className="text-zinc-500">Spread</span>
            <span className="font-mono text-zinc-300">
              {spread != null ? fmtCents(spread) : "—"}
            </span>
          </div>
          <div className="px-4 py-2">
            {view.bids.map((o, i) => (
              <BookRow
                key={`bid-${i}`}
                color="text-yes"
                bgFill="bg-yes/10"
                price={o.price}
                size={o.size}
                maxSize={maxSize}
                onClick={() => onLevelClick?.(o.price, "bid")}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BookRow({
  color,
  bgFill,
  price,
  size,
  maxSize,
  onClick,
}: {
  color: string;
  bgFill: string;
  price: number;
  size: number;
  maxSize: number;
  onClick: () => void;
}) {
  const fillPct = Math.min(100, (size / maxSize) * 100);
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative grid w-full grid-cols-[1fr_1fr_1fr] items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors hover:bg-bg/80"
    >
      <span
        className={`absolute right-0 top-0 h-full ${bgFill} pointer-events-none`}
        style={{ width: `${fillPct}%` }}
      />
      <span className={`relative font-mono ${color}`}>{fmtCents(price)}</span>
      <span className="relative text-right font-mono text-zinc-300">
        {fmtCount(size)}
      </span>
      <span className="relative text-right font-mono text-[10px] text-zinc-500">
        {fmtPct(price)}
      </span>
    </button>
  );
}
