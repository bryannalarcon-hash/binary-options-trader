import { redirect } from "next/navigation";

import { MAG7_TICKERS, type Ticker } from "@/lib/tickers";
import { atmStrike } from "@/lib/mock-data";

/**
 * `/trade/[ticker]` — redirects to the at-the-money strike for that ticker.
 * Falls back to AAPL if the URL ticker is unknown.
 */
export default async function TradeTickerPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const upper = ticker.toUpperCase() as Ticker;
  const known = (MAG7_TICKERS as readonly string[]).includes(upper);
  if (!known) {
    redirect("/markets");
  }
  const strike = atmStrike(upper);
  redirect(`/trade/${upper}/${strike}`);
}
