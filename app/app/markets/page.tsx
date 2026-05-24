"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";

import { MarketCard } from "@/components/MarketCard";
import { SettlementCountdown } from "@/components/SettlementCountdown";
import { MAG7_TICKERS, TICKER_NAME, type Ticker } from "@/lib/tickers";
import {
  changePctForTicker,
  spotForTicker,
} from "@/lib/mock-data";
import { useStrikeList } from "@/lib/markets-client";

type SortKey = "alpha" | "change" | "spot";

/**
 * Markets page (`/markets`).
 *
 * Implements IMPLEMENTATION_PLAN §16.2:
 *   - Sticky sub-header (search + sort + settlement countdown)
 *   - Grid of 7 MAG7 cards
 *   - Each card → live price + active contract count + expand→strike list
 *   - Per-strike click → /trade/[ticker]/[strike]
 *
 * Empty state for "markets not yet open" is rendered when the strike list
 * for the ticker comes back empty (e.g., the morning job hasn't run yet).
 */
export default function MarketsPage() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("alpha");
  const [refreshKey, setRefreshKey] = useState(0);

  const tickers: Ticker[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = MAG7_TICKERS.filter((t) => {
      if (!q) return true;
      return (
        t.toLowerCase().includes(q) ||
        TICKER_NAME[t].toLowerCase().includes(q)
      );
    });
    if (sort === "alpha") list = [...list].sort();
    if (sort === "change") {
      list = [...list].sort(
        (a, b) => changePctForTicker(b) - changePctForTicker(a),
      );
    }
    if (sort === "spot") {
      list = [...list].sort((a, b) => spotForTicker(b) - spotForTicker(a));
    }
    return list;
  }, [query, sort]);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-zinc-500">
            7 stocks — MAG7 — settle at 4:00 PM ET
          </p>
        </div>
        <SettlementCountdown />
      </header>

      <div className="sticky top-[57px] z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/95 p-3 backdrop-blur">
        <div className="relative flex-1 min-w-[180px]">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search MAG7 (AAPL, NVDA, Tesla…)"
            className="w-full rounded-md border border-border bg-bg pl-8 pr-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="alpha">Alphabetical</option>
          <option value="change">Biggest mover</option>
          <option value="spot">Highest spot</option>
        </select>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="rounded-md border border-border p-2 text-zinc-400 hover:text-zinc-100"
          aria-label="Refresh markets"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div
        key={refreshKey}
        className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
      >
        {tickers.map((t) => (
          <MarketCardWrapper key={t} ticker={t} />
        ))}
        {tickers.length === 0 && (
          <p className="col-span-full rounded-lg border border-dashed border-border bg-surface/40 p-6 text-center text-sm text-zinc-500">
            No tickers match &quot;{query}&quot;.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Wrapper exists so the empty-strike-list "Markets open at 9:00 AM ET" copy
 * can fall back when the morning job hasn't created any strikes yet.
 */
function MarketCardWrapper({ ticker }: { ticker: Ticker }) {
  const strikes = useStrikeList(ticker);
  if (strikes.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-xl font-semibold">{ticker}</span>
          <span className="text-xs text-zinc-500">{TICKER_NAME[ticker]}</span>
        </div>
        <p className="mt-6 text-xs uppercase tracking-wider text-zinc-500">
          Markets open at 9:00 AM ET
        </p>
      </div>
    );
  }
  return <MarketCard ticker={ticker} />;
}
