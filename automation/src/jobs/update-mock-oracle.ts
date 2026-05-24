import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";

import { env } from "../env";
import { buildAnchorContext, isProgramDeployed } from "../lib/anchor";
import { fetchMag7Prices, type HermesPrice } from "../lib/hermes";
import { configPda, oraclePda } from "../lib/pdas";
import { MAG7_TICKERS } from "../lib/tickers";
import { ctx } from "../logger";

const log = ctx("oracle");

export interface OracleUpdateResult {
  ticker: string;
  status: "updated" | "skipped" | "failed";
  priceCents?: number;
  publishTime?: number;
  reason?: string;
}

/**
 * Run one pass: fetch latest Hermes prices for each MAG7 ticker, post
 * `update_oracle` for each. We always write — the on-chain account just stores
 * the latest snapshot, so over-writing is harmless and keeps `publish_time`
 * fresh for `settle_market`.
 */
export async function runOracleUpdaterOnce(): Promise<OracleUpdateResult[]> {
  let anchor;
  try {
    // Oracle authority signs — for v1 this is the admin keypair (per spec:
    // "Call update_oracle... using oracle_authority (the admin keypair for v1)").
    anchor = buildAnchorContext(env.adminKeypairPath);
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

  const prices = await fetchMag7Prices(env.pythFeeds);
  const [config] = configPda(anchor.programId);
  const results: OracleUpdateResult[] = [];

  for (const ticker of MAG7_TICKERS) {
    const price = prices.get(ticker);
    if (!price) {
      results.push({
        ticker,
        status: "skipped",
        reason: "no hermes data",
      });
      continue;
    }
    try {
      const result = await postOracleUpdate(anchor, config, ticker, price);
      results.push(result);
    } catch (err) {
      const msg = errMsg(err);
      log.error({ ticker, err: msg }, "update_oracle failed");
      results.push({ ticker, status: "failed", reason: msg });
    }
  }

  log.info(
    {
      updated: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
    },
    "oracle pass complete",
  );
  return results;
}

async function postOracleUpdate(
  anchor: ReturnType<typeof buildAnchorContext>,
  config: ReturnType<typeof configPda>[0],
  ticker: string,
  price: HermesPrice,
): Promise<OracleUpdateResult> {
  // Mock oracle stores price in cents (the contract's documented convention),
  // so re-scale: raw_price * 10^expo gives USD, * 100 → cents.
  const priceCents = Math.round(price.priceUsd * 100);
  const confCents = Math.max(1, Math.round(price.confUsd * 100));

  const [oracle] = oraclePda(anchor.programId, ticker);

  await anchor.program.methods
    .updateOracle(
      ticker,
      new BN(priceCents),
      new BN(confCents),
      new BN(price.publishTime),
      // expo is fixed at -2 on-chain since we store cents; the IDL accepts i32.
      -2,
    )
    .accounts({
      config,
      oracle,
      oracleAuthority: anchor.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return {
    ticker,
    status: "updated",
    priceCents,
    publishTime: price.publishTime,
  };
}

/**
 * Backwards-compat: keep the `runOracleUpdater` name the original scaffold
 * exposed, in case other modules (or the scheduler) imported it.
 */
export const runOracleUpdater = runOracleUpdaterOnce;

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
// CLI entrypoint: `pnpm --filter automation oracle-update`
// -----------------------------------------------------------------------------
if (require.main === module) {
  runOracleUpdaterOnce()
    .then((results) => {
      log.info({ count: results.length }, "oracle updater finished");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err: errMsg(err) }, "oracle updater crashed");
      process.exit(1);
    });
}
