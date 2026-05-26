/**
 * Targeted settle helper for E2E (NVDA-only, single market).
 *
 * Unlike `pnpm --filter automation settle` (which settles EVERY open market and
 * would collide with the TSLA/AAPL swarms), this script:
 *   1. Pushes a CONTROLLED, fresh oracle price for one ticker via update_oracle
 *      (signed by the admin keypair, which is the oracle authority on localnet).
 *   2. Calls settle_market for ONE specific market address.
 *
 * TEST_BYPASS_TIME_GATE=true in .env.local lets settle run before expiry.
 *
 * Usage (cwd = automation/ so relative imports + .env.local resolve):
 *   node <tsx cli> settle-one.ts --market <ADDR> --ticker NVDA --price-cents 25000
 *
 * Prints a JSON line: { ok, settled, outcome, settlementPrice } so the Playwright
 * setup step can parse the result. NOT part of the app — test-only operator tool.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { configPda, oraclePda } from "../../../automation/src/lib/pdas";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(v: any): number {
  if (typeof v === "number") return v;
  if (v?.toNumber) return v.toNumber();
  return Number(v?.toString?.() ?? v);
}

async function main() {
  const marketStr = arg("market");
  const ticker = arg("ticker") ?? "NVDA";
  const priceCents = Number(arg("price-cents") ?? "25000"); // default $250 (> NVDA strikes)
  if (!marketStr) throw new Error("--market <address> is required");

  const anchor = buildAnchorContext(env.adminKeypairPath);
  const market = new PublicKey(marketStr);

  // Read the market first so we can report what should happen.
  const mAcc: any = await (anchor.program.account as any).market.fetch(market);
  const strike = num(mAcc.strike);
  const alreadySettled = Boolean(mAcc.settled);
  const oraclePk: PublicKey = mAcc.oracle;

  // 1. Push a controlled, fresh oracle price (oracle authority = admin).
  const [config] = configPda(anchor.programId);
  const [oracle] = oraclePda(anchor.programId, ticker);
  if (!oracle.equals(oraclePk)) {
    // The market references a specific oracle PDA; ours must match.
    console.error(
      `WARN: derived oracle ${oracle.toBase58()} != market.oracle ${oraclePk.toBase58()}`,
    );
  }
  // Stamp publish_time slightly in the PAST. The localnet validator clock can
  // lag host wall-clock by 1-2s; the contract rejects a future publish_time
  // (`age >= 0`). 30s back keeps us safely positive and well within the 300s
  // staleness window.
  const nowSec = Math.floor(Date.now() / 1000) - 30;
  await anchor.program.methods
    .updateOracle(ticker, new BN(priceCents), new BN(50), new BN(nowSec), -2)
    .accounts({
      config,
      oracle,
      oracleAuthority: anchor.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 2. Settle this one market (any signer is allowed as caller).
  let settleErr: string | null = null;
  if (!alreadySettled) {
    try {
      await anchor.program.methods
        .settleMarket()
        .accounts({
          market,
          oracle,
          config,
          caller: anchor.wallet.publicKey,
        })
        .rpc();
    } catch (e: any) {
      settleErr = e?.message ?? String(e);
    }
  }

  // Re-read post-settle.
  const after: any = await (anchor.program.account as any).market.fetch(market);
  const settled = Boolean(after.settled);
  const outcome = after.outcome ? JSON.stringify(after.outcome) : null;
  const settlementPrice =
    after.settlementPrice != null ? num(after.settlementPrice) : null;
  const yesWins = priceCents >= strike;

  console.log(
    JSON.stringify({
      ok: settled,
      ticker,
      market: marketStr,
      strike,
      priceCents,
      expectedOutcome: yesWins ? "yes" : "no",
      settled,
      outcome,
      settlementPrice,
      settleErr,
    }),
  );
  if (!settled) process.exit(2);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
