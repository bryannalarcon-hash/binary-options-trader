"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { OrderBookDisplay } from "@/components/OrderBookDisplay";
import { RecentTrades } from "@/components/RecentTrades";
import { SettlementCountdown } from "@/components/SettlementCountdown";
import { StrikeList } from "@/components/StrikeList";
import { TradePanel } from "@/components/TradePanel";
import {
  fmtCents,
  fmtPct,
  fmtPriceWithProb,
  fmtStockPrice,
  fmtUsdDollars,
} from "@/lib/format";
import { useMarket, useOrderBook, useRecentTrades } from "@/lib/markets-client";
import { useHoldingForMarket } from "@/lib/positions-client";
import { spotForTicker } from "@/lib/mock-data";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";

interface Props {
  ticker: Ticker;
  strike: number;
}

/**
 * Trade page client. 3-column desktop layout per §16.3:
 *   - Left rail   → StrikeList
 *   - Center      → market header + OrderBook + RecentTrades
 *   - Right rail  → TradePanel (+ position summary)
 *
 * Empty / settled / no-wallet states all handled gracefully.
 */
export function TradePageClient({ ticker, strike }: Props) {
  const market = useMarket(ticker, strike);
  const { book, loading: bookLoading } = useOrderBook(ticker, strike);
  const trades = useRecentTrades(ticker, strike);
  const holding = useHoldingForMarket(ticker, strike);
  const [pickedLimit, setPickedLimit] = useState<number | null>(null);

  const spot = spotForTicker(ticker);
  const yesMid =
    book && book.asks[0] && book.bids[0]
      ? Math.round((book.asks[0].price + book.bids[0].price) / 2)
      : 50;
  const noMid = 100 - yesMid;

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {ticker} &gt; {fmtStockPrice(strike)}
          </h1>
          <span className="text-xs text-zinc-500">
            {TICKER_NAME[ticker]} · Spot {fmtStockPrice(spot)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wider text-zinc-500">
              Yes
            </span>
            <span className="font-mono text-lg text-yes">
              {fmtCents(yesMid)}
            </span>
            <span className="text-xs text-zinc-500">= {fmtPct(yesMid)}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wider text-zinc-500">
              No
            </span>
            <span className="font-mono text-lg text-no">{fmtCents(noMid)}</span>
            <span className="text-xs text-zinc-500">= {fmtPct(noMid)}</span>
          </div>
          <SettlementCountdown
            expiryTs={market?.expiryTs}
          />
        </div>
      </header>

      {market?.settled ? (
        <SettlementBanner
          ticker={ticker}
          strike={strike}
          outcome={market.outcome}
          settlementPriceCents={market.settlementPrice}
          holding={holding}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <StrikeList ticker={ticker} currentStrike={strike} />
          <OracleAttribution ticker={ticker} />
        </div>

        <div className="space-y-4">
          <OrderBookDisplay
            book={book}
            loading={bookLoading}
            onLevelClick={(p) => setPickedLimit(p)}
          />
          <RecentTrades trades={trades} />
          <PayoffDisplay
            ticker={ticker}
            strike={strike}
            yesMid={yesMid}
          />
        </div>

        <div className="space-y-4">
          <TradePanel
            ticker={ticker}
            strike={strike}
            initialLimitCents={pickedLimit}
          />
          <PositionSummary
            ticker={ticker}
            strike={strike}
            yesHeld={holding.yes}
            noHeld={holding.no}
            yesMid={yesMid}
          />
        </div>
      </div>
    </section>
  );
}

function OracleAttribution({ ticker }: { ticker: Ticker }) {
  return (
    <a
      href={`https://pyth.network/price-feeds/equity-us-${ticker.toLowerCase()}-usd`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between rounded-lg border border-border bg-surface p-3 text-xs text-zinc-400 hover:border-accent"
    >
      <span>Settles via Pyth Network</span>
      <span className="inline-flex items-center gap-1 text-accent">
        {ticker}/USD <ExternalLink size={10} />
      </span>
    </a>
  );
}

function PayoffDisplay({
  ticker,
  strike,
  yesMid,
}: {
  ticker: Ticker;
  strike: number;
  yesMid: number;
}) {
  const strikeUsd = `$${(strike / 100).toFixed(2)}`;
  const yesPrice = fmtPriceWithProb(yesMid);
  const noPrice = fmtPriceWithProb(100 - yesMid);

  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-sm">
      <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-400">
        Payoff
      </h2>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-yes/30 bg-yes/5 p-3">
          <p className="text-xs uppercase tracking-wider text-yes">Yes</p>
          <p className="mt-1 font-mono text-lg">{yesPrice}</p>
          <p className="mt-2 text-xs leading-relaxed text-zinc-300">
            You pay {fmtUsdDollars(yesMid / 100)}. You win $1.00 if {ticker}{" "}
            closes above {strikeUsd}.
          </p>
        </div>
        <div className="rounded-md border border-no/30 bg-no/5 p-3">
          <p className="text-xs uppercase tracking-wider text-no">No</p>
          <p className="mt-1 font-mono text-lg">{noPrice}</p>
          <p className="mt-2 text-xs leading-relaxed text-zinc-300">
            You pay {fmtUsdDollars((100 - yesMid) / 100)}. You win $1.00 if{" "}
            {ticker} closes below {strikeUsd}.
          </p>
        </div>
      </div>
    </div>
  );
}

function PositionSummary({
  ticker,
  strike,
  yesHeld,
  noHeld,
  yesMid,
}: {
  ticker: Ticker;
  strike: number;
  yesHeld: number;
  noHeld: number;
  yesMid: number;
}) {
  if (yesHeld === 0 && noHeld === 0) {
    return null;
  }
  const yesValue = (yesHeld * yesMid) / 100;
  const noValue = (noHeld * (100 - yesMid)) / 100;
  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-xs">
      <p className="mb-2 text-zinc-400">Your position on this strike</p>
      <div className="space-y-1 font-mono">
        {yesHeld > 0 && (
          <p className="flex justify-between">
            <span className="text-yes">{yesHeld} Yes</span>
            <span>{fmtUsdDollars(yesValue)}</span>
          </p>
        )}
        {noHeld > 0 && (
          <p className="flex justify-between">
            <span className="text-no">{noHeld} No</span>
            <span>{fmtUsdDollars(noValue)}</span>
          </p>
        )}
      </div>
      <Link
        href="/portfolio"
        className="mt-3 inline-block text-[11px] text-accent hover:underline"
      >
        View in Portfolio →
      </Link>
      {/* If user holds the same strike on a Trade page for ticker we suggest in-context */}
      <p className="mt-2 text-[10px] text-zinc-500">
        Tip: {ticker} &gt; ${(strike / 100).toFixed(2)} — same strike.
      </p>
    </div>
  );
}

function SettlementBanner({
  ticker,
  strike,
  outcome,
  settlementPriceCents,
  holding,
}: {
  ticker: Ticker;
  strike: number;
  outcome: "yes" | "no" | null;
  settlementPriceCents: number | null;
  holding: { yes: number; no: number };
}) {
  const strikeUsd = `$${(strike / 100).toFixed(2)}`;
  const settlement =
    settlementPriceCents != null ? `$${(settlementPriceCents / 100).toFixed(2)}` : "—";
  const winningQty = outcome === "yes" ? holding.yes : holding.no;
  const winnerLabel = outcome === "yes" ? "Yes" : "No";
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/10 p-4 text-sm">
      <p className="font-semibold text-accent">Market settled</p>
      <p className="mt-1 text-zinc-200">
        {ticker} &gt; {strikeUsd} settled at {settlement} — {winnerLabel} wins.
        {winningQty > 0 ? (
          <span> You won ${winningQty}.00 — </span>
        ) : (
          <span> You held no winning tokens. </span>
        )}
        <Link href="/portfolio" className="text-accent underline">
          Redeem in Portfolio
        </Link>
      </p>
    </div>
  );
}
