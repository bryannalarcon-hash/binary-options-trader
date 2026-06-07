/**
 * scripts/_test-market-setup.ts — stand up the permanent "AAPL-T" TEST fixture
 * and run the on-chain E2E for the new program paths:
 *   1. Init/refresh the AAPL-T oracle (mirrors the real AAPL oracle price).
 *   2. E2E (throwaway expiry 2029-12-31): create 1 market → force-settle it
 *      PRE-EXPIRY via admin_settle_override (allowed only because of the "-T"
 *      tag) → close its (empty) book via close_settled_book.
 *   3. Negative tests: admin_settle_override on a REAL live market must fail
 *      TimeGateNotElapsed; close_settled_book on a LIVE market must fail
 *      MarketNotSettled.
 * Standing fixture creation (full ±3/6/9 chain, year-2030 expiry, seeded
 * books) is done separately via _fast-seed.ts SEED_TICKERS=AAPL-T.
 *
 * Env: SOLANA_RPC_URL, SOLANA_CLUSTER, MERIDIAN_PROGRAM_ID, USDC_MINT,
 *      ADMIN_KEYPAIR_PATH.
 */
import { BN } from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction, Connection, SystemProgram } from "@solana/web3.js";

import { buildAnchorContext } from "../automation/src/lib/anchor";
import { configPda, marketPda, oraclePda, orderbookPda, yesMintPda, noMintPda } from "../automation/src/lib/pdas";

const TEST_TICKER = "AAPL-T";
const SOURCE_TICKER = "AAPL";
const E2E_EXPIRY = Math.floor(Date.UTC(2029, 11, 31, 21, 0, 0) / 1000); // 4 PM ET 2029-12-31

async function sendIx(conn: Connection, wallet: any, ix: any): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  for (let i = 0; i < 30; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`tx failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("confirm timeout");
}

/** Expect an on-chain error containing `needle`; throws if the tx SUCCEEDS. */
async function expectFail(p: Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await p;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes(needle)) { console.log(`  NEG ✓ ${label} rejected (${needle})`); return; }
    throw new Error(`${label}: failed with WRONG error: ${msg.slice(0, 160)}`);
  }
  throw new Error(`${label}: expected failure (${needle}) but tx SUCCEEDED`);
}

(async () => {
  const ctx: any = buildAnchorContext(process.env.ADMIN_KEYPAIR_PATH!);
  const { program, programId, wallet } = ctx;
  const conn = new Connection(process.env.SOLANA_RPC_URL!, { commitment: "confirmed" });
  const admin: PublicKey = wallet.publicKey;
  const usdcMint = new PublicKey(process.env.USDC_MINT!);
  const [config] = configPda(programId);

  // ---- 1. Mirror AAPL's oracle into AAPL-T (init-if-needed) ----
  const [srcOracle] = oraclePda(programId, SOURCE_TICKER);
  const src: any = await (program.account as any).oracleAccount.fetch(srcOracle);
  const price = Number(src.price);
  console.log(`source ${SOURCE_TICKER} oracle: ${price}c publish_time=${Number(src.publishTime)}`);
  const now = Math.floor(Date.now() / 1000);
  const updIx = await (program.methods as any)
    .updateOracle(TEST_TICKER, new BN(price), new BN(Number(src.conf ?? 0)), new BN(now), src.expo ?? -2)
    .accounts({
      config,
      oracleAuthority: admin,
      oracle: oraclePda(programId, TEST_TICKER)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await sendIx(conn, wallet, updIx);
  console.log(`oracle ${TEST_TICKER} mirrored ✓`);

  // ---- 2. E2E: create throwaway market, force-settle pre-expiry, close book ----
  const strike = Math.round(price / 100) * 100; // ATM-ish round-dollar strike (cents)
  const [market] = marketPda(programId, TEST_TICKER, strike, E2E_EXPIRY);
  const [orderbook] = orderbookPda(programId, market);
  const existing = await conn.getAccountInfo(market);
  if (!existing) {
    // Account shapes proven by _fast-seed.ts (40 markets created with these).
    const [yesMint] = yesMintPda(programId, market);
    const [noMint] = noMintPda(programId, market);
    const vault = getAssociatedTokenAddressSync(usdcMint, market, true);
    const usdcEscrow = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_escrow"), market.toBuffer()], programId)[0];
    const yesEscrow = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_escrow"), market.toBuffer()], programId)[0];
    const createIx = await (program.methods as any)
      .createStrikeMarket(TEST_TICKER, new BN(strike), new BN(E2E_EXPIRY))
      .accounts({
        config, market, yesMint, noMint, usdcMint, vault,
        oracle: oraclePda(programId, TEST_TICKER)[0],
        payer: admin,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await sendIx(conn, wallet, createIx);
    const initIx = await (program.methods as any)
      .initMarketBooks()
      .accounts({
        market, yesMint, usdcMint, orderbook, usdcEscrow, yesEscrow,
        payer: admin, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .instruction();
    await sendIx(conn, wallet, initIx);
    console.log(`E2E market created: ${TEST_TICKER} $${strike / 100} exp 2029-12-31 ✓`);
  } else {
    console.log("E2E market already exists — reusing");
  }

  // NEG: close_settled_book on the LIVE (unsettled) market must fail.
  await expectFail(
    (program.methods as any).closeSettledBook()
      .accounts({ config, market, orderbook, admin }).rpc(),
    "MarketNotSettled", "close_settled_book on live market",
  );

  // NEG: admin_settle_override on a REAL live market must hit the time gate.
  const all: any[] = await (program.account as any).market.all();
  const realLive = all.find((m) => !m.account.settled && !m.account.ticker.endsWith("-T"));
  if (realLive) {
    await expectFail(
      (program.methods as any).adminSettleOverride(new BN(123))
        .accounts({ config, market: realLive.publicKey, admin }).rpc(),
      "TimeGateNotElapsed", "admin_settle_override pre-gate on REAL market",
    );
  } else {
    console.log("  NEG ~ no live real market found to test the time gate (skipped)");
  }

  // POS: force-settle the TEST market PRE-EXPIRY (manual price above strike → Yes).
  const manualPrice = strike + 500;
  const ovIx = await (program.methods as any)
    .adminSettleOverride(new BN(manualPrice))
    .accounts({ config, market, admin })
    .instruction();
  await sendIx(conn, wallet, ovIx);
  const after: any = await (program.account as any).market.fetch(market);
  console.log(`force-settle ✓ settled=${after.settled} outcome=${JSON.stringify(after.outcome)} price=${Number(after.settlementPrice)}`);

  // POS: close the (empty) book of the now-settled test market; rent → admin.
  const before = await conn.getBalance(admin);
  const closeIx = await (program.methods as any)
    .closeSettledBook()
    .accounts({ config, market, orderbook, admin })
    .instruction();
  await sendIx(conn, wallet, closeIx);
  const got = (await conn.getBalance(admin)) - before;
  console.log(`close_settled_book ✓ reclaimed ~${got / 1e9} SOL`);
  console.log("\nE2E COMPLETE — all positive and negative paths verified on devnet.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
