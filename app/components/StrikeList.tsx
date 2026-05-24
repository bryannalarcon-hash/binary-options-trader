"use client";

import { useStrikeList } from "@/lib/markets-client";
import { spotForTicker } from "@/lib/mock-data";
import { fmtCents, fmtPct } from "@/lib/format";
import type { Ticker } from "@/lib/tickers";

import { StrikeRow } from "./StrikeRow";

interface Props {
  ticker: Ticker;
  /** Currently-selected strike (highlighted). */
  currentStrike: number;
}

/**
 * StrikeList — Trade-page left rail listing every strike for the ticker.
 * Click row → navigates to `/trade/[ticker]/[strike]`.
 */
export function StrikeList({ ticker, currentStrike }: Props) {
  const strikes = useStrikeList(ticker);
  const spot = spotForTicker(ticker);

  return (
    <aside className="rounded-lg border border-border bg-surface p-3">
      <h2 className="px-2 pb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
        Strikes
      </h2>
      <div className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-2 px-3 pb-2 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Strike</span>
        <span className="text-right">Yes</span>
        <span className="text-right">No</span>
        <span className="text-right">Vol</span>
      </div>
      <div className="space-y-px">
        {strikes.map((s) => (
          <StrikeRow
            key={s.strike}
            ticker={ticker}
            strike={s.strike}
            yesCents={s.yesCents}
            noCents={s.noCents}
            volume={s.volume}
            spotCents={spot}
            selected={s.strike === currentStrike}
            formatPriceAsCents={fmtCents}
            formatProb={fmtPct}
          />
        ))}
        {strikes.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">
            No strikes yet.
          </p>
        )}
      </div>
    </aside>
  );
}
