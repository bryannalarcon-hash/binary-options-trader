/**
 * Cancel-order tx builder.
 *
 * Wraps the on-chain `cancel_order` instruction. The UI surface for "cancel
 * a resting maker order" isn't wired in v1 yet (the active-orders panel is
 * still TODO), but the Anchor entrypoint is exposed here so any new caller
 * can submit a cancel without reinventing the account graph.
 *
 * Refunds the user's escrowed USDC (for a bid) or YES tokens (for an ask)
 * by signing as the market PDA over the corresponding escrow vault.
 */

import { BN, AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

import { env } from "./env";
import idl from "./meridian-idl.json";

export type CancelSide = "bid" | "ask";

const ORDERBOOK_SEED = Buffer.from("orderbook");
const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");
const YES_MINT_SEED = Buffer.from("yes_mint");

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function buildProgram(
  connection: Connection,
  wallet: WalletContextState,
): { program: Program; programId: PublicKey; provider: AnchorProvider } {
  if (!env.programId) {
    throw new Error("Program ID not configured");
  }
  const programId = new PublicKey(env.programId);
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idlAny = idl as Idl & { address?: string };
  idlAny.address = programId.toBase58();
  const program = new Program(idlAny, provider);
  return { program, programId, provider };
}

/**
 * Submit a `cancel_order` tx for the given (market, side, index) slot.
 *
 * Throws if no wallet is connected, the program isn't deployed, or the
 * cancel itself reverts (e.g. the order isn't owned by the user).
 *
 * @param market   Market PDA as base58 string.
 * @param side     Which book side the order rests on.
 * @param index    Order-book slot index (0..15).
 * @returns        The confirmed tx signature.
 */
export async function buildAndSendCancelOrder(
  connection: Connection,
  wallet: WalletContextState,
  market: string,
  side: CancelSide,
  index: number,
): Promise<{ signature: string }> {
  if (!wallet.connected || !wallet.publicKey) {
    throw new Error("Wallet not connected");
  }
  if (!env.usdcMint) {
    throw new Error("USDC mint not configured");
  }
  if (index < 0 || index > 15 || !Number.isInteger(index)) {
    throw new Error("Index must be an integer in [0, 15]");
  }
  const { program, programId, provider } = buildProgram(connection, wallet);
  const user = wallet.publicKey;

  const marketPk = new PublicKey(market);
  const usdcMint = new PublicKey(env.usdcMint);
  const yesMint = pda([YES_MINT_SEED, marketPk.toBuffer()], programId);
  const orderbook = pda([ORDERBOOK_SEED, marketPk.toBuffer()], programId);
  const usdcEscrow = pda([USDC_ESCROW_SEED, marketPk.toBuffer()], programId);
  const yesEscrow = pda([YES_ESCROW_SEED, marketPk.toBuffer()], programId);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userYes = getAssociatedTokenAddressSync(yesMint, user);

  const tx = new Transaction();
  // Make sure both target ATAs exist before the contract tries to credit them.
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdc, user, usdcMint),
    createAssociatedTokenAccountIdempotentInstruction(user, userYes, user, yesMint),
  );

  const sideEnum = side === "bid" ? { bid: {} } : { ask: {} };
  const ix = await (program.methods as any)
    .cancelOrder(sideEnum, index)
    .accounts({
      market: marketPk,
      orderbook,
      yesMint,
      usdcMint,
      userUsdc,
      userYes,
      usdcEscrow,
      yesEscrow,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);

  const signature = await provider.sendAndConfirm(tx);
  return { signature };
}

/** Lightweight helper if a caller already has a `BN` index; just delegates. */
export async function buildAndSendCancelOrderBN(
  connection: Connection,
  wallet: WalletContextState,
  market: string,
  side: CancelSide,
  index: BN | number,
): Promise<{ signature: string }> {
  const idx = typeof index === "number" ? index : index.toNumber();
  return buildAndSendCancelOrder(connection, wallet, market, side, idx);
}
