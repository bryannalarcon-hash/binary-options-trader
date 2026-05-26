import { type Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { isNyseTradingDay } from "../calendar";
import { env } from "../env";
import { sendAlert } from "../lib/alerts";
import { getAnchorContext, isProgramDeployed } from "../lib/anchor";
import { fetchOpenMarkets, type MarketSummary } from "../lib/markets";
import { configPda } from "../lib/pdas";
import { sleep } from "../lib/retry";
import { postWebhook } from "../lib/webhook";
import { ctx } from "../logger";
import { runOracleUpdaterOnce } from "./update-oracle";

const log = ctx("settle");

export interface SettleResult {
  market: string;
  ticker: string;
  strike: number;
  status: "settled" | "skipped" | "failed";
  attempts: number;
  reason?: string;
}

/**
 * Settlement job (~4:05 PM ET).
 *
 * For each open market: ensure oracle freshness, call `settle_market`. On
 * OracleStale / OracleConfidenceWide, retry every `settleRetryInterval` for up
 * to `settleMaxRetrySeconds`. On persistent failure: warn + webhook alert.
 */
export async function runSettleJob(): Promise<SettleResult[]> {
  if (!env.skipCalendarCheck && !isNyseTradingDay()) {
    log.info("not a trading day — skipping");
    return [];
  }

  let anchor;
  try {
    anchor = getAnchorContext(env.automationKeypairPath);
  } catch (err) {
    log.warn(
      { err: errMsg(err) },
      "anchor context unavailable — contract likely not deployed yet",
    );
    return [];
  }
  if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
    log.warn(
      { programId: anchor.programId.toBase58() },
      "program not deployed at expected ID — skipping",
    );
    return [];
  }

  const openMarkets = await fetchOpenMarkets(anchor.program);
  log.info({ count: openMarkets.length }, "open markets to settle");

  // Ensure oracles are fresh BEFORE we start retrying settles — saves cycles
  // when prices are simply stale.
  if (env.useHermesOracle) {
    try {
      await runOracleUpdaterOnce();
    } catch (err) {
      log.warn({ err: errMsg(err) }, "pre-settle oracle refresh failed");
      // Persistent oracle failure is a critical event — fire the webhook even
      // though we'll still attempt settles below (a single market may have
      // a fresh enough oracle PDA).
      await postWebhook(env.alertWebhookUrl, {
        severity: "critical",
        source: "settle",
        message: "pre-settle oracle refresh failed",
        details: { error: errMsg(err) },
      });
    }
  }

  const results: SettleResult[] = [];
  for (const market of openMarkets) {
    const res = await settleOneMarket(anchor.program, market);
    results.push(res);
    log.info(res, "market settle result");
  }

  // Aggregate critical event: if anything failed, surface the count so the
  // operator can decide whether to invoke admin_settle_override.
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    await postWebhook(env.alertWebhookUrl, {
      severity: "critical",
      source: "settle",
      message: `${failed.length}/${results.length} markets failed to settle — admin override may be required after the 1h delay`,
      details: {
        total: results.length,
        failed_count: failed.length,
        failed_markets: failed.map((r) => ({
          ticker: r.ticker,
          strike: r.strike,
          attempts: r.attempts,
          reason: r.reason,
        })),
      },
    });
  }
  return results;
}

async function settleOneMarket(
  program: Program,
  market: MarketSummary,
): Promise<SettleResult> {
  const deadline = Date.now() + env.settleMaxRetrySeconds * 1000;
  let attempts = 0;
  let lastErr: unknown;

  while (Date.now() <= deadline) {
    attempts++;
    try {
      await program.methods
        .settleMarket()
        .accounts({
          market: market.address,
          oracle: market.oracle,
          config: configPda(program.programId)[0],
          caller: program.provider.publicKey ?? PublicKey.default,
        })
        .rpc();
      return {
        market: market.address.toBase58(),
        ticker: market.ticker,
        strike: market.strike,
        status: "settled",
        attempts,
      };
    } catch (err) {
      lastErr = err;
      const msg = errMsg(err);
      if (isOracleRetryable(msg)) {
        log.warn(
          {
            market: market.address.toBase58(),
            ticker: market.ticker,
            strike: market.strike,
            attempt: attempts,
            err: msg,
          },
          "settle blocked on oracle; sleeping before retry",
        );
        // Re-poke the oracle each cycle so a fresh Pyth price is available.
        if (env.useHermesOracle) {
          await runOracleUpdaterOnce().catch((e) =>
            log.warn({ err: errMsg(e) }, "oracle refresh during retry failed"),
          );
        }
        await sleep(env.settleRetryInterval * 1000);
        continue;
      }
      // Non-retryable: bail out immediately.
      break;
    }
  }

  const reason = errMsg(lastErr);
  await sendAlert({
    severity: "warning",
    source: "settle",
    message: `settle_market failed for ${market.ticker} @ ${market.strike}`,
    details: {
      market: market.address.toBase58(),
      ticker: market.ticker,
      strike: market.strike,
      attempts,
      reason,
    },
  });
  // Also fire the raw webhook with the spec's canonical envelope so external
  // dashboards can distinguish per-market retry exhaustion from oracle/admin
  // events.
  await postWebhook(env.alertWebhookUrl, {
    severity: "error",
    source: "settle",
    message: `settle_market retry exhausted for ${market.ticker} @ ${market.strike}`,
    ticker: market.ticker,
    market: market.address.toBase58(),
    details: { strike: market.strike, attempts, reason },
  });
  return {
    market: market.address.toBase58(),
    ticker: market.ticker,
    strike: market.strike,
    status: "failed",
    attempts,
    reason,
  };
}

function isOracleRetryable(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("oraclestale") ||
    m.includes("oracle is too stale") ||
    m.includes("oracleconfidencewide") ||
    m.includes("confidence band") ||
    m.includes("0x1776") || // 6006 / 6007 hex anchor codes (rough match)
    m.includes("0x1777")
  );
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// -----------------------------------------------------------------------------
// CLI entrypoint: `pnpm --filter automation settle`
// -----------------------------------------------------------------------------
if (require.main === module) {
  runSettleJob()
    .then((results) => {
      log.info({ count: results.length }, "settle job finished");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err: errMsg(err) }, "settle job crashed");
      process.exit(1);
    });
}
