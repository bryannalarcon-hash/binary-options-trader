/**
 * Operator helpers for E2E (Node-side, admin/oracle-authority keypair). Lets a
 * test deterministically settle ONE market to a chosen outcome by pushing a
 * controlled oracle close price, then calling settle_market. TEST_BYPASS_TIME_GATE
 * (set in .env.local) lets settle run before expiry.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { configPda, oraclePda } from "../../../automation/src/lib/pdas";

const num = (v: any): number =>
  typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v);

export interface SettleResult {
  settled: boolean;
  outcome: "yes" | "no" | null;
  settlementPrice: number | null;
  strike: number;
}

/**
 * Settle (ticker, strike) at a chosen close price (cents). priceCents >= strike
 * → YES wins; otherwise NO wins. Returns the post-settle market state.
 */
export async function settleMarket(
  ticker: string,
  strikeCents: number,
  priceCents: number,
): Promise<SettleResult> {
  const a = buildAnchorContext(env.adminKeypairPath);
  const all: any[] = await (a.program.account as any).market.all();
  const m = all.find(
    (x) => x.account.ticker === ticker && num(x.account.strike) === strikeCents,
  );
  if (!m) throw new Error(`settleMarket: ${ticker} $${strikeCents / 100} not found`);
  const market: PublicKey = m.publicKey;
  const [config] = configPda(a.programId);
  const [oracle] = oraclePda(a.programId, ticker);

  // Push a controlled, fresh oracle price (stamp 30s back to dodge validator
  // clock lag tripping the "publish_time in the future" check).
  const nowSec = Math.floor(Date.now() / 1000) - 30;
  await a.program.methods
    .updateOracle(ticker, new BN(priceCents), new BN(50), new BN(nowSec), -2)
    .accounts({
      config,
      oracle,
      oracleAuthority: a.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  if (!m.account.settled) {
    await a.program.methods
      .settleMarket()
      .accounts({ market, oracle, config, caller: a.wallet.publicKey })
      .rpc();
  }

  const after: any = await (a.program.account as any).market.fetch(market);
  const outcome = after.outcome
    ? "yes" in after.outcome
      ? "yes"
      : "no"
    : null;
  return {
    settled: Boolean(after.settled),
    outcome,
    settlementPrice: after.settlementPrice != null ? num(after.settlementPrice) : null,
    strike: num(after.strike),
  };
}
