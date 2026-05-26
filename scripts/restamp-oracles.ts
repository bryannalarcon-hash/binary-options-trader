#!/usr/bin/env tsx
/**
 * Re-stamp every MAG7 oracle PDA after the `MockOracle → OracleAccount` rename.
 *
 * Problem: the rename changed the Anchor account discriminator. Existing
 * on-chain oracle PDAs still carry the OLD `MockOracle` discriminator, so the
 * redeployed program — which expects `OracleAccount` — reverts on them with an
 * `AccountDiscriminatorMismatch`. `update_oracle` uses `init_if_needed`, which
 * also tries to load the existing account first, so it cannot self-heal.
 *
 * Fix: for each ticker
 *   1. `close_oracle(ticker)` — closes the bricked PDA (rent → admin) WITHOUT
 *      deserializing it (handler uses an UncheckedAccount). Tolerated if the
 *      account doesn't exist (already closed / never created).
 *   2. `update_oracle(ticker, price, conf, now, -2)` with a live Pyth Hermes
 *      price — re-creates the PDA fresh with the CORRECT discriminator.
 *   3. Re-fetch the account via the new IDL to confirm it deserializes cleanly
 *      as `OracleAccount`.
 *
 * The oracle PDA ADDRESS is derived from `["oracle", ticker]` and is unchanged
 * by close+recreate, so existing markets (which reference the oracle by
 * address) remain settleable.
 *
 * Run (signed by keys/admin.json against the RPC in .env, i.e. Helius devnet):
 *   ./automation/node_modules/.bin/tsx scripts/restamp-oracles.ts
 */

import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";

import { env } from "../automation/src/env";
import {
  buildAnchorContext,
  isProgramDeployed,
} from "../automation/src/lib/anchor";
import { fetchMag7Prices, type HermesPrice } from "../automation/src/lib/hermes";
import { configPda, oraclePda } from "../automation/src/lib/pdas";
import { MAG7_TICKERS } from "../automation/src/lib/tickers";

interface RestampResult {
  ticker: string;
  pda: string;
  closed: "closed" | "did-not-exist" | "close-failed";
  recreated: boolean;
  priceCents?: number;
  priceSource?: "hermes" | "skipped";
  verified: boolean;
  error?: string;
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

/**
 * Heuristic for the "account doesn't exist" case. When the oracle PDA has no
 * lamports/data, the program's manual ownership check (`oracle.owner ==
 * program_id`) fails because a non-existent account is owned by the System
 * Program. We treat that — and the generic AccountNotInitialized / "could not
 * find account" shapes — as a benign "nothing to close".
 */
function isMissingAccountError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("invalidoracleauthority") || // owner-check fail on empty PDA
    m.includes("account does not exist") ||
    m.includes("accountnotinitialized") ||
    m.includes("could not find account") ||
    m.includes("0xbc4") // AccountNotInitialized anchor code, just in case
  );
}

async function main(): Promise<void> {
  console.log("[restamp] RPC:", env.rpcUrl.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("[restamp] cluster:", env.cluster);

  // Oracle authority == admin keypair (same gate as update_oracle/close_oracle).
  const anchor = buildAnchorContext(env.adminKeypairPath);
  console.log("[restamp] signer (oracle_authority):", anchor.wallet.publicKey.toBase58());

  if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
    throw new Error(
      `program not deployed at ${anchor.programId.toBase58()} on ${env.rpcUrl}`,
    );
  }

  const [config] = configPda(anchor.programId);
  const prices = await fetchMag7Prices(env.pythFeeds);
  const nowSec = Math.floor(Date.now() / 1000);

  const results: RestampResult[] = [];

  for (const ticker of MAG7_TICKERS) {
    const [oracle] = oraclePda(anchor.programId, ticker);
    const result: RestampResult = {
      ticker,
      pda: oracle.toBase58(),
      closed: "close-failed",
      recreated: false,
      verified: false,
    };

    // ---- Step 1: close the bricked PDA ----
    try {
      const sig = await (anchor.program.methods as any)
        .closeOracle(ticker)
        .accounts({
          config,
          oracleAuthority: anchor.wallet.publicKey,
          oracle,
        })
        .rpc();
      result.closed = "closed";
      console.log(`[restamp] ${ticker.padEnd(6)} closed   tx=${sig.slice(0, 12)}…`);
    } catch (err) {
      const msg = errMsg(err);
      if (isMissingAccountError(msg)) {
        result.closed = "did-not-exist";
        console.log(`[restamp] ${ticker.padEnd(6)} close skipped (account doesn't exist)`);
      } else {
        result.closed = "close-failed";
        result.error = `close: ${msg}`;
        console.error(`[restamp] ${ticker.padEnd(6)} close FAILED — ${msg}`);
        results.push(result);
        continue; // don't try to recreate over a still-bricked account
      }
    }

    // ---- Step 2: recreate via update_oracle with a live Hermes price ----
    const price: HermesPrice | undefined = prices.get(ticker);
    if (!price) {
      result.priceSource = "skipped";
      result.error = (result.error ? result.error + "; " : "") + "no hermes price";
      console.error(`[restamp] ${ticker.padEnd(6)} recreate SKIPPED — no hermes price`);
      results.push(result);
      continue;
    }

    const priceCents = Math.round(price.priceUsd * 100);
    // 0.5% confidence band, clamped to >=1 cent (matches settle_market gate).
    const confCents = Math.max(1, Math.floor(priceCents * 0.005));
    result.priceCents = priceCents;
    result.priceSource = "hermes";

    try {
      const sig = await (anchor.program.methods as any)
        .updateOracle(
          ticker,
          new BN(priceCents),
          new BN(confCents),
          new BN(nowSec),
          -2,
        )
        .accounts({
          config,
          oracleAuthority: anchor.wallet.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      result.recreated = true;
      console.log(
        `[restamp] ${ticker.padEnd(6)} recreated $${(priceCents / 100).toFixed(2)} (hermes)  tx=${sig.slice(0, 12)}…`,
      );
    } catch (err) {
      const msg = errMsg(err);
      result.error = (result.error ? result.error + "; " : "") + `update: ${msg}`;
      console.error(`[restamp] ${ticker.padEnd(6)} recreate FAILED — ${msg}`);
      results.push(result);
      continue;
    }

    // ---- Step 3: verify it deserializes as OracleAccount via the new IDL ----
    try {
      const acct: any = await (anchor.program.account as any).oracleAccount.fetch(
        oracle,
      );
      const ok =
        acct.ticker === ticker &&
        Number(acct.price) === priceCents &&
        Number(acct.expo) === -2;
      result.verified = ok;
      if (ok) {
        console.log(
          `[restamp] ${ticker.padEnd(6)} verified OracleAccount {price=${acct.price}, conf=${acct.conf}, expo=${acct.expo}, publish_time=${acct.publishTime}}`,
        );
      } else {
        result.error =
          (result.error ? result.error + "; " : "") +
          `verify mismatch: ${JSON.stringify({ ticker: acct.ticker, price: String(acct.price), expo: acct.expo })}`;
        console.error(`[restamp] ${ticker.padEnd(6)} verify MISMATCH`);
      }
    } catch (err) {
      const msg = errMsg(err);
      result.error = (result.error ? result.error + "; " : "") + `verify: ${msg}`;
      console.error(`[restamp] ${ticker.padEnd(6)} verify FAILED — ${msg}`);
    }

    results.push(result);
  }

  // ---- Summary ----
  console.log("\n[restamp] ============ SUMMARY ============");
  for (const r of results) {
    const status = r.verified ? "OK" : "FAILED";
    console.log(
      `  ${r.ticker.padEnd(6)} ${status.padEnd(7)} closed=${r.closed} recreated=${r.recreated} verified=${r.verified}` +
        (r.error ? `  err=${r.error}` : ""),
    );
  }
  const ok = results.filter((r) => r.verified).length;
  console.log(`[restamp] ${ok}/${results.length} oracles verified as OracleAccount`);

  if (ok !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[restamp] crashed:", errMsg(err));
  process.exit(1);
});
