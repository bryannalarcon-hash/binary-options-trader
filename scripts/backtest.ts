#!/usr/bin/env tsx
/**
 * scripts/backtest.ts — Historical backtest of the strike-chain pricing model.
 *
 * Per IMPLEMENTATION_PLAN §14.4 #8 [MAY]:
 *   "Run the strike-chain pricing logic against 6 months of historical MAG7
 *    closes; show that the implied PDF predicted realized outcomes reasonably
 *    (calibration error within bounds). This is the quantitative receipt."
 *
 * What this does:
 *   1. Loads historical daily closes for one MAG7 ticker (Pyth Hermes
 *      `/v2/updates/price/historical` endpoint if reachable; otherwise falls
 *      back to a 30-day embedded sample so the script always produces output).
 *   2. For each historical "previous close", it computes the Meridian strike
 *      grid (±3/6/9% in $10 increments — same code path the morning job uses).
 *   3. Synthesizes a market-implied risk-neutral distribution from a calibrated
 *      log-normal anchor (1-day vol ≈ realized vol of the sample window). In a
 *      live Meridian deployment this distribution would be DERIVED from
 *      observed Yes prices via the Breeden-Litzenberger transform — we don't
 *      have historical Meridian quote data, so the model proxies what the
 *      MARKET WOULD HAVE SAID had it priced rationally off the same vol.
 *   4. For each (predicted_prob, realized_outcome) pair across strikes, bucket
 *      into 10 probability bins; compare bucket midpoint to realized hit rate.
 *   5. Compute the Brier score, mean calibration error, and a bucket table.
 *
 * Honesty caveats (printed in stdout too):
 *   - This is illustrative. Without historical Meridian quotes we cannot test
 *     the ACTUAL market-implied PDF; we test that the strike-chain WOULD have
 *     been well-calibrated under a log-normal prior with the right vol.
 *   - The result is an upper bound on calibration quality (the model knows
 *     the right vol). Real markets would underperform until they learn vol.
 *
 * Usage:
 *   pnpm tsx scripts/backtest.ts AAPL
 *   pnpm tsx scripts/backtest.ts AAPL --days 60
 *   pnpm tsx scripts/backtest.ts AAPL --vol 0.018       # override daily vol
 *   pnpm tsx scripts/backtest.ts AAPL --no-hermes       # force embedded data
 *
 * Output: pretty-printed JSON with:
 *   { ticker, days_tested, mean_brier, mean_abs_calibration_error,
 *     calibration_bucket_table, caveats }
 */

import * as path from "path";
import * as dotenv from "dotenv";

import { computeStrikes } from "../automation/src/lib/strikes";

// Load env for PYTH_HERMES_URL / PYTH_FEED_*; harmless if missing.
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------
function parseArgs(argv: string[]): {
  ticker: string;
  days: number;
  vol: number | null;
  useHermes: boolean;
} {
  const positional: string[] = [];
  let days = 30;
  let vol: number | null = null;
  let useHermes = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") {
      days = Number(argv[++i] ?? "30");
    } else if (a === "--vol") {
      vol = Number(argv[++i] ?? "0.018");
    } else if (a === "--no-hermes") {
      useHermes = false;
    } else if (a.startsWith("--")) {
      // Unknown flag — ignore (forward-compat).
    } else {
      positional.push(a);
    }
  }

  const ticker = (positional[0] ?? "AAPL").toUpperCase();
  return { ticker, days, vol, useHermes };
}

// -----------------------------------------------------------------------------
// Historical price loading
// -----------------------------------------------------------------------------

/**
 * 30 days of approximate AAPL/MSFT/NVDA/etc closes. These are deliberately
 * round-ish numbers — illustrative, not financial advice.
 * Format: { ticker → [oldest → newest] daily closes in USD }
 */
const EMBEDDED_HISTORY: Record<string, number[]> = {
  AAPL: [
    218.10, 219.30, 220.85, 221.40, 219.95, 222.30, 224.10, 225.55, 223.80,
    222.05, 220.40, 221.95, 223.65, 226.10, 228.30, 227.85, 229.40, 230.55,
    228.95, 230.10, 232.40, 231.80, 233.05, 230.75, 232.20, 234.10, 233.60,
    235.45, 237.20, 235.85,
  ],
  MSFT: [
    412.5, 415.2, 418.0, 416.4, 419.8, 422.1, 425.0, 423.6, 421.2, 419.5,
    422.8, 425.5, 428.3, 430.1, 432.5, 431.0, 433.4, 435.2, 437.6, 436.1,
    438.5, 440.0, 438.8, 441.2, 443.5, 441.9, 444.3, 446.0, 448.2, 446.8,
  ],
  GOOGL: [
    175.4, 176.8, 178.2, 177.0, 179.5, 181.2, 180.4, 182.5, 184.1, 183.0,
    181.8, 183.6, 185.2, 186.8, 188.4, 187.0, 189.1, 190.6, 192.3, 191.0,
    192.8, 194.5, 193.2, 195.0, 196.8, 195.4, 197.2, 198.9, 197.5, 199.3,
  ],
  AMZN: [
    198.3, 200.1, 202.5, 201.0, 203.8, 205.6, 207.2, 206.0, 208.4, 210.1,
    208.7, 211.0, 213.2, 215.0, 214.0, 216.5, 218.3, 217.0, 219.4, 221.2,
    220.0, 222.5, 224.0, 222.8, 225.0, 226.5, 225.2, 227.8, 229.5, 228.0,
  ],
  NVDA: [
    138.5, 141.2, 143.8, 142.0, 145.4, 148.0, 146.2, 149.5, 152.0, 150.4,
    153.6, 156.2, 154.8, 157.5, 160.1, 158.4, 161.0, 163.5, 162.0, 164.8,
    167.3, 165.5, 168.2, 170.8, 169.0, 172.0, 174.5, 173.0, 175.8, 178.2,
  ],
  META: [
    538.0, 542.5, 545.0, 543.2, 547.8, 550.5, 553.0, 551.4, 555.0, 558.5,
    556.8, 560.2, 563.0, 565.5, 568.0, 566.4, 569.8, 572.5, 575.0, 573.2,
    576.5, 579.0, 577.4, 580.5, 583.0, 581.4, 584.5, 587.0, 585.4, 588.5,
  ],
  TSLA: [
    245.0, 248.5, 252.0, 250.3, 253.8, 257.0, 255.2, 258.5, 262.0, 260.3,
    263.5, 266.8, 265.0, 268.5, 271.0, 269.2, 272.5, 275.0, 273.2, 276.5,
    279.0, 277.2, 280.5, 283.0, 281.2, 284.5, 287.0, 285.2, 288.5, 291.0,
  ],
};

interface DailyClose {
  date: string; // YYYY-MM-DD
  close: number;
}

/**
 * Try Pyth Hermes historical endpoint. Pyth's V2 API exposes single-timestamp
 * lookups (`/v2/updates/price/historical?ids[]=...&publish_time=...`). We make
 * one call per day at 8 PM UTC (= 4 PM ET, near US close).
 *
 * Returns null if Hermes is unreachable or returns no data — caller falls
 * back to EMBEDDED_HISTORY.
 */
async function tryFetchHermesHistory(
  ticker: string,
  feedId: string,
  days: number,
): Promise<DailyClose[] | null> {
  const hermesUrl = process.env.PYTH_HERMES_URL || "https://hermes.pyth.network";
  const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;

  const out: DailyClose[] = [];
  const now = Math.floor(Date.now() / 1000);
  // 20:00 UTC = 4 PM ET — close enough to NYSE close for an illustrative test.
  const closeOfDayUTC = (offsetDays: number): number => {
    const t = new Date(now * 1000);
    t.setUTCDate(t.getUTCDate() - offsetDays);
    t.setUTCHours(20, 0, 0, 0);
    return Math.floor(t.getTime() / 1000);
  };

  for (let d = days; d >= 1; d--) {
    const ts = closeOfDayUTC(d);
    const url = `${hermesUrl}/v2/updates/price/historical?ids[]=${id}&publish_time=${ts}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        parsed?: Array<{ price: { price: string; expo: number } }>;
      };
      const entry = body.parsed?.[0];
      if (!entry) continue;
      const close = Number(entry.price.price) * Math.pow(10, entry.price.expo);
      if (Number.isFinite(close) && close > 0) {
        out.push({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          close,
        });
      }
    } catch {
      // Network errors → silently skip this day; caller will fallback if
      // we end up with no data.
    }
  }

  return out.length >= 10 ? out : null;
}

function loadEmbedded(ticker: string, days: number): DailyClose[] {
  const series = EMBEDDED_HISTORY[ticker];
  if (!series) {
    throw new Error(
      `No embedded history for ${ticker}. Available: ${Object.keys(EMBEDDED_HISTORY).join(", ")}`,
    );
  }
  const slice = series.slice(-Math.min(days, series.length));
  // Synthesize date stamps working backwards from "yesterday".
  const out: DailyClose[] = [];
  const today = new Date();
  for (let i = 0; i < slice.length; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - (slice.length - i));
    out.push({ date: d.toISOString().slice(0, 10), close: slice[i] });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Statistics
// -----------------------------------------------------------------------------

/** Sample standard deviation of daily log returns. */
function dailyLogVol(closes: number[]): number {
  if (closes.length < 2) return 0.02;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.sqrt(variance);
}

/**
 * Normal CDF. Abramowitz & Stegun approximation 26.2.17 — accurate to ~1e-7.
 * Used to price binary options under log-normal dynamics.
 */
function normCdf(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Probability that S_T >= K under log-normal dynamics with daily vol σ and
 * spot S0, T=1 day, zero drift (risk-neutral with r≈0 and short horizon).
 *   P(S_T >= K) = N(d2) where d2 = (ln(S0/K) - 0.5·σ²) / σ
 */
function probAboveStrike(spot: number, strike: number, sigma: number): number {
  if (sigma <= 0) return spot >= strike ? 1 : 0;
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma) / sigma;
  return normCdf(d2);
}

// -----------------------------------------------------------------------------
// Backtest core
// -----------------------------------------------------------------------------

interface Prediction {
  date: string;
  strikeCents: number;
  predictedProb: number;
  realizedOutcome: 0 | 1; // 1 = "S_T >= K"
}

function backtest(history: DailyClose[], vol: number): Prediction[] {
  const out: Prediction[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    const prevClose = history[i].close;
    const nextClose = history[i + 1].close;

    const prevCents = Math.round(prevClose * 100);
    const strikes = computeStrikes(prevCents);

    for (const strikeCents of strikes) {
      const strike = strikeCents / 100;
      const p = probAboveStrike(prevClose, strike, vol);
      const realized: 0 | 1 = nextClose >= strike ? 1 : 0;
      out.push({
        date: history[i + 1].date,
        strikeCents,
        predictedProb: p,
        realizedOutcome: realized,
      });
    }
  }
  return out;
}

interface BucketRow {
  bucket: string;
  bucket_lo: number;
  bucket_hi: number;
  count: number;
  predicted_avg: number;
  realized_rate: number;
  abs_error: number;
}

function calibrationTable(preds: Prediction[]): BucketRow[] {
  const buckets: BucketRow[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10,
      hi = (i + 1) / 10;
    const inBucket = preds.filter(
      (p) =>
        p.predictedProb >= lo &&
        (i === 9 ? p.predictedProb <= hi : p.predictedProb < hi),
    );
    const count = inBucket.length;
    const predictedAvg =
      count > 0 ? inBucket.reduce((a, b) => a + b.predictedProb, 0) / count : 0;
    const realizedRate =
      count > 0 ? inBucket.reduce((a, b) => a + b.realizedOutcome, 0) / count : 0;
    buckets.push({
      bucket: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      bucket_lo: lo,
      bucket_hi: hi,
      count,
      predicted_avg: Number(predictedAvg.toFixed(4)),
      realized_rate: Number(realizedRate.toFixed(4)),
      abs_error: Number(Math.abs(predictedAvg - realizedRate).toFixed(4)),
    });
  }
  return buckets;
}

function meanBrier(preds: Prediction[]): number {
  if (preds.length === 0) return 0;
  const sum = preds.reduce(
    (a, b) => a + (b.predictedProb - b.realizedOutcome) ** 2,
    0,
  );
  return sum / preds.length;
}

function meanCalibrationError(table: BucketRow[]): number {
  const used = table.filter((r) => r.count > 0);
  if (used.length === 0) return 0;
  // Sample-size-weighted mean abs error.
  const total = used.reduce((a, b) => a + b.count, 0);
  return used.reduce((a, b) => a + b.abs_error * b.count, 0) / total;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const { ticker, days, vol: volOverride, useHermes } = parseArgs(
    process.argv.slice(2),
  );

  // Try Hermes first if we have a feed ID configured for this ticker.
  const feedId = process.env[`PYTH_FEED_${ticker}`] || "";
  let history: DailyClose[] | null = null;
  let source: "hermes" | "embedded" = "embedded";

  if (useHermes && feedId) {
    process.stderr.write(
      `[backtest] attempting Hermes historical fetch for ${ticker} (${days}d)…\n`,
    );
    history = await tryFetchHermesHistory(ticker, feedId, days);
    if (history) source = "hermes";
  }
  if (!history) {
    process.stderr.write(`[backtest] using embedded history for ${ticker}\n`);
    history = loadEmbedded(ticker, days);
  }
  if (history.length < 2) {
    throw new Error(
      `Need at least 2 days of history to backtest; got ${history.length}`,
    );
  }

  const closes = history.map((h) => h.close);
  const realizedVol = dailyLogVol(closes);
  const vol = volOverride ?? Math.max(0.005, realizedVol);

  const preds = backtest(history, vol);
  const table = calibrationTable(preds);
  const brier = meanBrier(preds);
  const calibErr = meanCalibrationError(table);

  const result = {
    ticker,
    source,
    days_tested: history.length,
    predictions_evaluated: preds.length,
    daily_vol_realized: Number(realizedVol.toFixed(5)),
    daily_vol_used: Number(vol.toFixed(5)),
    mean_brier: Number(brier.toFixed(5)),
    mean_abs_calibration_error: Number(calibErr.toFixed(5)),
    polymarket_benchmark_brier: 0.125,
    passes_polymarket_benchmark: brier < 0.125,
    calibration_bucket_table: table,
    caveats: [
      "This is an illustrative backtest. No historical Meridian quote data exists yet, so we proxy the market-implied PDF with a log-normal anchored on realized vol.",
      "A real Meridian backtest would derive the PDF from observed Yes prices via Breeden-Litzenberger (∂²C/∂K² ≈ pdf). This script tests that the strike grid itself produces well-calibrated outcomes under a correctly-priced model.",
      "Embedded history covers ~30 days of round-number closes — not real Pyth data, just enough to exercise the strike chain. Pass --no-hermes for deterministic output.",
    ],
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`[backtest] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
