import { env } from "../env";
import { ctx } from "../logger";

const log = ctx("hermes");

/**
 * One Pyth price update as returned by the Hermes V2 API.
 *
 * Hermes returns `price` and `conf` as STRING decimals (because they're often
 * large integers that exceed JS's safe-int range) with a separate `expo`. The
 * effective USD value is `price * 10^expo`. Equities typically have expo=-8.
 */
export interface HermesPrice {
  feedId: string;
  /** Integer price string from Pyth (e.g. "22018500000" → 220.185 with expo=-8). */
  priceRaw: string;
  /** Confidence interval in same units as `priceRaw`. */
  confRaw: string;
  /** Decimal exponent — multiply price/conf by 10^expo for the real number. */
  expo: number;
  /** Unix seconds when this price was published by the Pyth network. */
  publishTime: number;
  /** Convenience: float USD value. */
  priceUsd: number;
  /** Convenience: float confidence in USD. */
  confUsd: number;
}

/**
 * Fetch the latest Pyth Hermes prices for one or more feed IDs in a single
 * round-trip. Returns a map from feed_id → HermesPrice (or null if missing).
 *
 * Endpoint: GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=…
 */
export async function fetchHermesPrices(
  feedIds: string[],
): Promise<Map<string, HermesPrice>> {
  if (feedIds.length === 0) return new Map();

  const params = feedIds.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
  const url = `${env.pythHermesUrl}/v2/updates/price/latest?${params}`;

  log.debug({ url, count: feedIds.length }, "fetching hermes prices");

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`hermes returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };

  const out = new Map<string, HermesPrice>();
  for (const entry of body.parsed ?? []) {
    // Hermes returns ids WITHOUT the 0x prefix.
    const idWithPrefix = entry.id.startsWith("0x") ? entry.id : `0x${entry.id}`;
    const { price, conf, expo, publish_time } = entry.price;
    const scale = Math.pow(10, expo);
    out.set(idWithPrefix, {
      feedId: idWithPrefix,
      priceRaw: price,
      confRaw: conf,
      expo,
      publishTime: publish_time,
      priceUsd: Number(price) * scale,
      confUsd: Number(conf) * scale,
    });
  }

  return out;
}

/**
 * Convenience: fetch prices for the MAG7 set, keyed by ticker symbol.
 * Returns only tickers whose feed ID is configured AND whose Hermes call
 * returned a result.
 */
export async function fetchMag7Prices(
  feeds: Record<string, string>,
): Promise<Map<string, HermesPrice>> {
  const entries = Object.entries(feeds).filter(([, id]) => id);
  const ids = entries.map(([, id]) => id);
  const byId = await fetchHermesPrices(ids);

  const byTicker = new Map<string, HermesPrice>();
  for (const [ticker, id] of entries) {
    // Hermes may strip or keep the 0x — normalize on lookup.
    const withPrefix = id.startsWith("0x") ? id : `0x${id}`;
    const withoutPrefix = id.startsWith("0x") ? id.slice(2) : id;
    const got =
      byId.get(withPrefix) ??
      byId.get(withoutPrefix) ??
      byId.get(`0x${withoutPrefix}`);
    if (got) byTicker.set(ticker, got);
  }
  return byTicker;
}
