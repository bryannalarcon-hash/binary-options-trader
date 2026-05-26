"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

import { useSpotPrice, useStrikeList } from "@/lib/markets-client";
import { MAG7_TICKERS, type Ticker } from "@/lib/tickers";

/**
 * `/trade/[ticker]` — client redirect to the at-the-money strike for that
 * ticker, derived from REAL on-chain markets + oracle spot. Falls back to the
 * first available strike, or to /markets if the ticker is unknown.
 *
 * Client-side because ATM selection needs live on-chain reads (a server
 * redirect can't read the chain synchronously, and we never hardcode a strike).
 */
export default function TradeTickerPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = use(params);
  const upper = ticker.toUpperCase() as Ticker;
  const known = (MAG7_TICKERS as readonly string[]).includes(upper);
  const router = useRouter();
  const { rows } = useStrikeList(known ? upper : "AAPL");
  const { spotUsd } = useSpotPrice(known ? upper : "AAPL");

  useEffect(() => {
    if (!known) {
      router.replace("/markets");
      return;
    }
    if (rows.length === 0) return; // wait for real strikes
    const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;
    let target = rows[0]!.strike;
    if (spotCents != null) {
      target = rows.reduce((best, r) =>
        Math.abs(r.strike - spotCents) < Math.abs(best - spotCents) ? r.strike : best,
        rows[0]!.strike,
      );
    }
    router.replace(`/trade/${upper}/${target}`);
  }, [known, rows, spotUsd, upper, router]);

  return (
    <div className="page" style={{ paddingTop: 48 }}>
      <div style={{ color: "var(--text-3)", fontSize: 14, textAlign: "center" }}>
        {known ? "Loading markets…" : "Unknown ticker — redirecting…"}
      </div>
    </div>
  );
}
