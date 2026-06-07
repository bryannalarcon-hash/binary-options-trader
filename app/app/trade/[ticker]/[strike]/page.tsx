import { redirect } from "next/navigation";

import { MAG7_TICKERS, isTestTicker, type Ticker } from "@/lib/tickers";
import { TradePageClient } from "./TradePageClient";

interface PageProps {
  params: Promise<{ ticker: string; strike: string }>;
}

/**
 * Trade page (`/trade/[ticker]/[strike]`).
 *
 * Server validates the URL params, then renders the interactive client.
 * Accepts the MAG7 tickers plus "-T" TEST fixtures (e.g. "AAPL-T").
 */
export default async function TradePage({ params }: PageProps) {
  const { ticker, strike } = await params;
  const upper = ticker.toUpperCase() as Ticker;
  if (!(MAG7_TICKERS as readonly string[]).includes(upper) && !isTestTicker(upper)) {
    redirect("/markets");
  }
  const strikeNum = Number(strike);
  if (!Number.isFinite(strikeNum) || strikeNum <= 0) {
    redirect(`/trade/${upper}`);
  }
  return <TradePageClient ticker={upper} strike={strikeNum} />;
}
