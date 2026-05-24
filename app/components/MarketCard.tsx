"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

import {
  changePctForTicker,
  spotForTicker,
} from "@/lib/mock-data";
import {
  fmtCents,
  fmtPct,
  fmtPctChange,
  fmtStockPrice,
} from "@/lib/format";
import { useStrikeList } from "@/lib/markets-client";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";

import { SettlementCountdown } from "./SettlementCountdown";
import { StrikeRow } from "./StrikeRow";

interface Props {
  ticker: Ticker;
}

/**
 * MarketCard — one card per MAG7 ticker on the /markets grid.
 *
 * Fulfills:
 *   - PRD §2.9 "active contracts grouped by stock ticker"
 *   - IMPLEMENTATION_PLAN §16.2 per-card requirements (live price, expand→strikes)
 *
 * Click anywhere on the card body → /trade/[ticker] (defaults to ATM).
 * Click the chevron → expand inline strike list.
 */
export function MarketCard({ ticker }: Props) {
  const [expanded, setExpanded] = useState(false);
  const strikes = useStrikeList(ticker);
  const spotCents = spotForTicker(ticker);
  const changePct = changePctForTicker(ticker);
  const positiveChange = changePct >= 0;

  return (
    <div
      id={ticker}
      className="rounded-lg border border-border bg-surface transition-colors hover:border-accent"
    >
      <Link
        href={`/trade/${ticker}`}
        className="block px-5 pt-5"
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold tracking-tight">{ticker}</span>
              <span className="text-xs text-zinc-500">
                {TICKER_NAME[ticker]}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-lg">
              {fmtStockPrice(spotCents)}
            </div>
            <div
              className={`font-mono text-xs ${positiveChange ? "text-yes" : "text-no"}`}
            >
              {fmtPctChange(changePct)}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-zinc-400">
          <span>{strikes.length} active strikes</span>
          <SettlementCountdown />
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            Settles via Pyth — {ticker}/USD
            <ExternalLink size={10} />
          </span>
        </div>
      </Link>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-center gap-1 border-t border-border/50 bg-surface/60 px-5 py-2 text-xs text-zinc-400 transition-colors hover:bg-bg/40 hover:text-zinc-200"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse strikes" : "Expand strikes"}
      >
        {expanded ? "Hide strikes" : "Show strikes"}
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="space-y-px border-t border-border/60 bg-bg/40 px-2 py-2">
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-2 px-3 text-[10px] uppercase tracking-wider text-zinc-500">
            <span>Strike</span>
            <span className="text-right">Yes</span>
            <span className="text-right">No</span>
            <span className="text-right">Vol</span>
          </div>
          {strikes.map((s) => (
            <StrikeRow
              key={s.strike}
              ticker={ticker}
              strike={s.strike}
              yesCents={s.yesCents}
              noCents={s.noCents}
              volume={s.volume}
              spotCents={spotCents}
              showYesNoProb
              formatPriceAsCents={fmtCents}
              formatProb={fmtPct}
            />
          ))}
        </div>
      )}
    </div>
  );
}
