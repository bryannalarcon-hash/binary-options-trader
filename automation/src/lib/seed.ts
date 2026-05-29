import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

import { configPda, orderbookPda } from "./pdas";
import { sendHttp } from "./tx";

const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");
const escrow = (seed: Buffer, programId: PublicKey, market: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed, market.toBuffer()], programId)[0];

const clampCents = (c: number): number => Math.max(1, Math.min(99, Math.round(c)));

/**
 * Fair YES mid (cents) from oracle spot vs strike — the same monotonic proxy the
 * UI uses for an empty book. Falls back to 50 (coin-flip) when spot is unknown.
 */
export function fairMidCents(spotUsd: number | null, strikeCents: number): number {
  if (spotUsd == null) return 50;
  const strikeUsd = strikeCents / 100;
  const diffPct = ((spotUsd - strikeUsd) / strikeUsd) * 100;
  return clampCents(50 + diffPct * 4);
}

/** bid/ask around mid ± spread/2, clamped so 1 <= bid < ask <= 99. */
export function quote(midCents: number, spreadCents: number): { bid: number; ask: number } {
  const half = Math.max(1, Math.floor(spreadCents / 2));
  let bid = clampCents(midCents - half);
  let ask = clampCents(midCents + half);
  if (ask <= bid) {
    bid = clampCents(Math.min(bid, 98));
    ask = clampCents(bid + 1);
  }
  return { bid, ask };
}

export interface SeedParams {
  program: any;
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcMint: PublicKey;
  feeDestination: PublicKey;
  spotUsd: number | null;
  strikeCents: number;
  size: number;
  spreadCents: number;
}

/**
 * Post a two-sided book (one resting bid + one ask of `size`) around the
 * oracle-implied fair mid, so the market isn't an empty `0/100`. Confirms via
 * HTTP polling (see {@link sendHttp}). The MM holds the leftover NO leg as
 * unhedged inventory — fine for a play-money demo.
 *
 * Order matters: post the BID first (while the MM holds no NO — the contract's
 * book-path guard only fires on a Bid that *acquires* YES while holding NO),
 * THEN mint the YES inventory (which leaves the MM holding NO), THEN the ASK.
 */
export async function seedMarketBook(p: SeedParams): Promise<{ bid: number; ask: number }> {
  const me = p.payer.publicKey;
  const [config] = configPda(p.programId);
  const [orderbook] = orderbookPda(p.programId, p.market);
  const usdcEscrow = escrow(USDC_ESCROW_SEED, p.programId, p.market);
  const yesEscrow = escrow(YES_ESCROW_SEED, p.programId, p.market);
  const vault = getAssociatedTokenAddressSync(p.usdcMint, p.market, true);
  const userUsdc = getAssociatedTokenAddressSync(p.usdcMint, me, false);
  const userYes = getAssociatedTokenAddressSync(p.yesMint, me, false);
  const userNo = getAssociatedTokenAddressSync(p.noMint, me, false);
  const feeDestinationUsdc = getAssociatedTokenAddressSync(p.usdcMint, p.feeDestination, true);

  const ataIxs = () => [
    createAssociatedTokenAccountIdempotentInstruction(me, userUsdc, me, p.usdcMint),
    createAssociatedTokenAccountIdempotentInstruction(me, userYes, me, p.yesMint),
    createAssociatedTokenAccountIdempotentInstruction(me, userNo, me, p.noMint),
  ];
  const placeOrderIx = (side: "bid" | "ask", price: number) =>
    p.program.methods
      .placeOrder(side === "bid" ? { bid: {} } : { ask: {} }, price, new BN(p.size))
      .accounts({
        config,
        market: p.market,
        orderbook,
        yesMint: p.yesMint,
        noMint: p.noMint,
        usdcMint: p.usdcMint,
        userUsdc,
        userYes,
        userNo,
        counterpartyUsdc: userUsdc,
        counterpartyYes: userYes,
        usdcEscrow,
        yesEscrow,
        feeDestinationUsdc,
        user: me,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

  const { bid, ask } = quote(fairMidCents(p.spotUsd, p.strikeCents), p.spreadCents);

  // 1. BID (guard-exempt while MM holds no NO).
  await sendHttp(p.connection, p.payer, [...ataIxs(), await placeOrderIx("bid", bid)]);
  // 2. Mint YES inventory to back the ask.
  const mintIx = await p.program.methods
    .mintPair(new BN(p.size))
    .accounts({
      config,
      market: p.market,
      yesMint: p.yesMint,
      noMint: p.noMint,
      usdcMint: p.usdcMint,
      vault,
      userUsdc,
      userYes,
      userNo,
      user: me,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendHttp(p.connection, p.payer, [...ataIxs(), mintIx]);
  // 3. ASK.
  await sendHttp(p.connection, p.payer, [...ataIxs(), await placeOrderIx("ask", ask)]);

  return { bid, ask };
}
