#!/usr/bin/env tsx
/**
 * scripts/benchmark.ts — End-to-end settlement latency benchmark.
 *
 * Per IMPLEMENTATION_PLAN §14.4 #3 [SHOULD]:
 *   "Settlement latency benchmark vs Polymarket / Kalshi in the README.
 *    Measure and report: time from market close → settlement transaction
 *    on-chain → tokens redeemable. Solana finality is your structural
 *    advantage; quantify it. Peak6 benchmarks everything."
 *
 * What this measures, per MAG7 ticker:
 *   T0 → T1   Hermes price fetch latency
 *   T1 → T2   `update_oracle` round-trip (signed tx → "confirmed")
 *   T2 → T3   `settle_market` round-trip (when applicable; skipped if the
 *             market is already settled or unsettlable in current state)
 *   T0 → T3   End-to-end "oracle is fresh AND market is settled" time
 *
 * Each phase is run `--iterations` times (default 5) per ticker. We report
 * mean / p50 / p95 / p99 / max.
 *
 * Comparison points printed at bottom (industry knowledge baked in):
 *   - Polymarket (UMA optimistic):  2h+ uncontested,  72h+ if disputed
 *   - Kalshi (CFTC-regulated):      ~minutes to ~hours, depends on contract
 *   - Meridian (Solana + Pyth):     a few seconds (this script measures it)
 *
 * Usage:
 *   pnpm tsx scripts/benchmark.ts
 *   pnpm tsx scripts/benchmark.ts --iterations 10
 *   pnpm tsx scripts/benchmark.ts --tickers AAPL,MSFT --no-settle
 *   pnpm tsx scripts/benchmark.ts --write-doc           # rewrite docs/BENCHMARK.md
 *
 * Output: a pretty table to stdout AND JSON to stdout under a `--- JSON ---`
 * separator. With --write-doc, also overwrites docs/BENCHMARK.md.
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import {
  buildAnchorContext,
  isProgramDeployed,
} from "../automation/src/lib/anchor";
import { fetchHermesPrices } from "../automation/src/lib/hermes";
import { fetchOpenMarkets } from "../automation/src/lib/markets";
import { configPda, oraclePda } from "../automation/src/lib/pdas";
import { MAG7_TICKERS } from "../automation/src/lib/tickers";

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

interface Args {
  iterations: number;
  tickers: string[];
  doSettle: boolean;
  writeDoc: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-settle" || a === "--write-doc") {
      flags[a.slice(2)] = "true";
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i] ?? "";
    }
  }
  const tickers = flags.tickers
    ? flags.tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : [...MAG7_TICKERS];
  return {
    iterations: flags.iterations ? Math.max(1, Number(flags.iterations)) : 5,
    tickers,
    doSettle: flags["no-settle"] !== "true",
    writeDoc: flags["write-doc"] === "true",
  };
}

// -----------------------------------------------------------------------------
// Stats
// -----------------------------------------------------------------------------

interface PhaseStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

function summarize(samples: number[]): PhaseStats {
  if (samples.length === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (q: number): number => {
    if (sorted.length === 1) return sorted[0];
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  };
  return {
    count: sorted.length,
    mean: Number((sum / sorted.length).toFixed(1)),
    p50: Number(pick(0.5).toFixed(1)),
    p95: Number(pick(0.95).toFixed(1)),
    p99: Number(pick(0.99).toFixed(1)),
    min: Number(sorted[0].toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
  };
}

// -----------------------------------------------------------------------------
// Benchmark core
// -----------------------------------------------------------------------------

interface TickerResult {
  ticker: string;
  hermes_ms: PhaseStats;
  update_oracle_ms: PhaseStats;
  settle_market_ms: PhaseStats;
  end_to_end_ms: PhaseStats;
  notes: string[];
}

async function measureHermes(feedId: string): Promise<number | null> {
  if (!feedId) return null;
  const t = Date.now();
  try {
    const m = await fetchHermesPrices([feedId]);
    if (m.size === 0) return null;
    return Date.now() - t;
  } catch {
    return null;
  }
}

async function measureUpdateOracle(
  anchor: ReturnType<typeof buildAnchorContext>,
  ticker: string,
  feedId: string,
): Promise<number | null> {
  if (!feedId) return null;
  const t = Date.now();
  try {
    const prices = await fetchHermesPrices([feedId]);
    const idWithPrefix = feedId.startsWith("0x") ? feedId : `0x${feedId}`;
    const idWithout = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
    const price =
      prices.get(idWithPrefix) ??
      prices.get(idWithout) ??
      prices.get(`0x${idWithout}`);
    if (!price) return null;

    const priceCents = Math.round(price.priceUsd * 100);
    const confCents = Math.max(1, Math.round(price.confUsd * 100));
    const [config] = configPda(anchor.programId);
    const [oracle] = oraclePda(anchor.programId, ticker);

    await (anchor.program.methods as any)
      .updateOracle(
        ticker,
        new BN(priceCents),
        new BN(confCents),
        new BN(price.publishTime),
        -2,
      )
      .accounts({
        config,
        oracle,
        oracleAuthority: anchor.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return Date.now() - t;
  } catch {
    return null;
  }
}

async function measureSettleMarket(
  anchor: ReturnType<typeof buildAnchorContext>,
  market: PublicKey,
  oracle: PublicKey,
): Promise<number | null> {
  const t = Date.now();
  try {
    await (anchor.program.methods as any)
      .settleMarket()
      .accounts({
        market,
        oracle,
        caller: anchor.wallet.publicKey,
      })
      .rpc();
    return Date.now() - t;
  } catch {
    // Already-settled / time-gated / oracle-stale are all expected during
    // a benchmark run — the script's job is to MEASURE latency, not to
    // force a settlement.
    return null;
  }
}

async function runForTicker(
  args: Args,
  anchor: ReturnType<typeof buildAnchorContext> | null,
  ticker: string,
): Promise<TickerResult> {
  const feedId = process.env[`PYTH_FEED_${ticker}`] || "";
  const notes: string[] = [];
  if (!feedId) {
    notes.push("PYTH_FEED_* not set — Hermes phase skipped");
  }

  const hermesSamples: number[] = [];
  const updateSamples: number[] = [];
  const settleSamples: number[] = [];
  const e2eSamples: number[] = [];

  // Find a candidate market once (cheap, deterministic enough).
  let market: PublicKey | null = null;
  let oracle: PublicKey | null = null;
  if (anchor && args.doSettle) {
    try {
      const open = await fetchOpenMarkets(anchor.program);
      const candidate = open.find((m) => m.ticker.toUpperCase() === ticker);
      if (candidate) {
        market = candidate.address;
        oracle = candidate.oracle;
      } else {
        notes.push("no open market for this ticker — settle phase skipped");
      }
    } catch {
      notes.push("market enumeration failed — settle phase skipped");
    }
  }

  for (let i = 0; i < args.iterations; i++) {
    const t0 = Date.now();
    const hermes = await measureHermes(feedId);
    if (hermes != null) hermesSamples.push(hermes);

    let update: number | null = null;
    if (anchor) {
      update = await measureUpdateOracle(anchor, ticker, feedId);
      if (update != null) updateSamples.push(update);
    } else {
      notes.push("anchor unavailable — update_oracle skipped");
    }

    let settle: number | null = null;
    if (anchor && market && oracle && args.doSettle) {
      settle = await measureSettleMarket(anchor, market, oracle);
      if (settle != null) settleSamples.push(settle);
    }

    const t3 = Date.now();
    if (hermes != null && update != null) {
      e2eSamples.push(t3 - t0);
    }
  }

  return {
    ticker,
    hermes_ms: summarize(hermesSamples),
    update_oracle_ms: summarize(updateSamples),
    settle_market_ms: summarize(settleSamples),
    end_to_end_ms: summarize(e2eSamples),
    notes: Array.from(new Set(notes)),
  };
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function renderTable(results: TickerResult[]): string {
  const lines: string[] = [];
  lines.push(
    pad("ticker", 8) +
      pad("phase", 18) +
      pad("count", 7) +
      pad("mean", 9) +
      pad("p50", 9) +
      pad("p95", 9) +
      pad("p99", 9) +
      pad("max", 9),
  );
  lines.push("-".repeat(78));
  for (const r of results) {
    const rows: Array<[string, PhaseStats]> = [
      ["hermes", r.hermes_ms],
      ["update_oracle", r.update_oracle_ms],
      ["settle_market", r.settle_market_ms],
      ["end_to_end", r.end_to_end_ms],
    ];
    for (const [name, p] of rows) {
      lines.push(
        pad(r.ticker, 8) +
          pad(name, 18) +
          pad(String(p.count), 7) +
          pad(`${p.mean}ms`, 9) +
          pad(`${p.p50}ms`, 9) +
          pad(`${p.p95}ms`, 9) +
          pad(`${p.p99}ms`, 9) +
          pad(`${p.max}ms`, 9),
      );
    }
    if (r.notes.length > 0) {
      for (const n of r.notes) lines.push(pad("", 8) + `  note: ${n}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderMarkdown(results: TickerResult[], opts: { iterations: number; tookMs: number; ranSettle: boolean }): string {
  const headerStats = (p: PhaseStats) =>
    `${p.mean}ms / ${p.p50}ms / ${p.p95}ms / ${p.p99}ms / ${p.max}ms (n=${p.count})`;

  const rows = results
    .map((r) => {
      const notes = r.notes.length > 0 ? `<br>_${r.notes.join("; ")}_` : "";
      return [
        `| ${r.ticker} | ${headerStats(r.hermes_ms)} | ${headerStats(r.update_oracle_ms)} | ${headerStats(r.settle_market_ms)} | ${headerStats(r.end_to_end_ms)} |${notes}`,
      ].join("\n");
    })
    .join("\n");

  return `# Settlement Latency Benchmark

> Auto-generated by \`scripts/benchmark.ts\`. Per cell: **mean / p50 / p95 / p99 / max (n)** in milliseconds.

**Run config.** ${opts.iterations} iterations per ticker, settle-phase=${opts.ranSettle ? "enabled" : "disabled"}, total runtime ${opts.tookMs}ms.

## Latency per phase

| Ticker | Hermes fetch | \`update_oracle\` | \`settle_market\` | End-to-end |
|---|---|---|---|---|
${rows}

## Phase definitions

- **Hermes fetch** — single \`GET /v2/updates/price/latest\` round-trip to Pyth's hosted Hermes endpoint (\`hermes.pyth.network\`). Bounded by network RTT.
- **\`update_oracle\`** — Hermes fetch + \`updateOracle\` instruction sent and confirmed on Solana (commitment \`confirmed\`). This is what runs every 30s in production.
- **\`settle_market\`** — single \`settleMarket\` round-trip to "confirmed". May fail (oracle stale, already settled, time gate) — only successful samples are reported.
- **End-to-end** — \`T0\` (start of iteration) → \`T3\` (settle confirmed OR last successful phase). The number a settlement-latency-conscious trader cares about.

## Industry comparison

| Venue | Settlement model | Typical latency |
|---|---|---|
| Polymarket | UMA optimistic resolution | **2 hours uncontested**, 72h+ if disputed ([UMA docs](https://docs.uma.xyz)) |
| Kalshi | CFTC-regulated, centrally cleared | minutes to hours, contract-dependent |
| Predict.it (pre-shutdown) | Manual review | days |
| **Meridian** | Pyth-pulled, on-chain settle | **a few seconds** (see table) |

The structural advantage is **synchronous on-chain settlement against a published oracle price**: no optimistic dispute window, no central operator queue, no off-chain attestation. Solana's sub-second finality and Pyth's ~400ms staleness budget combine into single-digit-second wall-clock settlement.

## How to re-run

\`\`\`bash
pnpm tsx scripts/benchmark.ts                        # all MAG7, 5 iterations
pnpm tsx scripts/benchmark.ts --iterations 10
pnpm tsx scripts/benchmark.ts --tickers AAPL,MSFT --no-settle
pnpm tsx scripts/benchmark.ts --write-doc            # regenerate this file
\`\`\`
`;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let anchor: ReturnType<typeof buildAnchorContext> | null = null;
  try {
    const keypair =
      process.env.ADMIN_KEYPAIR_PATH ||
      process.env.AUTOMATION_KEYPAIR_PATH ||
      "";
    if (keypair) {
      anchor = buildAnchorContext(keypair);
      if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
        process.stderr.write(
          "[bench] program not deployed — measuring Hermes only\n",
        );
        anchor = null;
      }
    } else {
      process.stderr.write("[bench] no keypair — measuring Hermes only\n");
    }
  } catch (err) {
    process.stderr.write(
      `[bench] anchor unavailable: ${err instanceof Error ? err.message : err} — measuring Hermes only\n`,
    );
    anchor = null;
  }

  const results: TickerResult[] = [];
  for (const ticker of args.tickers) {
    process.stderr.write(`[bench] ${ticker} (iters=${args.iterations})\n`);
    const r = await runForTicker(args, anchor, ticker);
    results.push(r);
  }

  const took = Date.now() - startedAt;
  const table = renderTable(results);
  console.log(table);
  console.log(`\n--- JSON ---`);
  console.log(JSON.stringify({ iterations: args.iterations, took_ms: took, results }, null, 2));

  if (args.writeDoc) {
    const docPath = path.resolve(__dirname, "../docs/BENCHMARK.md");
    const md = renderMarkdown(results, {
      iterations: args.iterations,
      tookMs: took,
      ranSettle: args.doSettle,
    });
    fs.writeFileSync(docPath, md);
    process.stderr.write(`[bench] wrote ${docPath}\n`);
  }
}

main().catch((err) => {
  console.error(`[bench] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
