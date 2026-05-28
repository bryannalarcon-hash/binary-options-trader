"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

import {
  useResolvedStrikeList,
  useSpotPrice,
  useStrikeList,
} from "@/lib/markets-client";
import { pickRedirectStrike } from "@/lib/trade-redirect";
import { MAG7_TICKERS, type Ticker } from "@/lib/tickers";

/**
 * `/trade/[ticker]` — client redirect to the at-the-money strike for that
 * ticker, derived from REAL on-chain markets + oracle spot.
 *
 * After the 4:00 PM ET close every 0DTE market is settled, so the ACTIVE strike
 * chain (`useStrikeList`) is empty. The OLD code `return`ed early on
 * `rows.length === 0` and NEVER redirected → perpetual "Loading markets…". We
 * now also consider SETTLED strikes so a resolved market still opens read-only
 * (Polymarket-style), and once loading settles we ALWAYS resolve: either
 * redirect to a real strike or route to /markets — never spin forever.
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
  const lookupTicker = known ? upper : "AAPL";
  const { rows: activeRows, loading: activeLoading, error: activeError } =
    useStrikeList(lookupTicker);
  const { rows: settledRows, loading: settledLoading } =
    useResolvedStrikeList(lookupTicker);
  const { spotUsd } = useSpotPrice(lookupTicker);

  useEffect(() => {
    if (!known) {
      router.replace("/markets");
      return;
    }
    // Wait only while the chain reads are GENUINELY loading and we have nothing
    // to act on yet. Once they've settled (or errored), we MUST resolve below.
    const stillLoading =
      (activeLoading || settledLoading) &&
      activeRows.length === 0 &&
      settledRows.length === 0 &&
      !activeError;
    if (stillLoading) return;

    const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;
    const target = pickRedirectStrike(
      activeRows.map((r) => r.strike),
      settledRows.map((r) => r.strike),
      spotCents,
    );
    if (target != null) {
      router.replace(`/trade/${upper}/${target}`);
    } else {
      // No active AND no settled strikes for this ticker — nothing to open.
      router.replace("/markets");
    }
  }, [
    known,
    activeRows,
    settledRows,
    activeLoading,
    settledLoading,
    activeError,
    spotUsd,
    upper,
    router,
  ]);

  return (
    <div className="page" style={{ paddingTop: 48 }}>
      <div style={{ color: "var(--text-3)", fontSize: 14, textAlign: "center" }}>
        {known ? "Loading markets…" : "Unknown ticker — redirecting…"}
      </div>
    </div>
  );
}
