#!/usr/bin/env tsx
/**
 * One-shot helper: create the USDC associated-token-account (ATA) owned by
 * `FEE_DESTINATION_PUBKEY` on whichever cluster `SOLANA_RPC_URL` points at.
 *
 * Why this exists
 * ---------------
 * The `place_order` instruction added in this iteration takes a new required
 * account, `fee_destination_usdc`, which must be an SPL token account with
 *   - mint  == config.usdc_mint
 *   - owner == config.fee_destination
 *
 * On devnet the fee_destination pubkey is `FEE_DESTINATION_PUBKEY` (see .env),
 * and that account has never been touched — so its USDC ATA does not exist yet.
 * Without the ATA the first post-upgrade trade reverts (AccountNotInitialized).
 *
 * Run this ONCE before redeploying the program upgrade. Idempotent:
 *   - if the ATA already exists, prints its address and exits 0
 *   - if the admin wallet has < 0.002 SOL for rent, errors out
 *
 * Usage:
 *   pnpm tsx scripts/create-fee-destination-ata.ts
 * Requires env: SOLANA_RPC_URL, USDC_MINT, FEE_DESTINATION_PUBKEY,
 *               ADMIN_KEYPAIR_PATH (admin pays the rent).
 */

import * as fs from "fs";
import * as path from "path";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

const REPO_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

async function main(): Promise<void> {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const usdcMintStr = process.env.USDC_MINT;
  const feeDestStr = process.env.FEE_DESTINATION_PUBKEY;
  const adminPath =
    process.env.ADMIN_KEYPAIR_PATH || path.join(REPO_ROOT, "keys", "admin.json");

  if (!usdcMintStr) throw new Error("USDC_MINT not set in env");
  if (!feeDestStr) throw new Error("FEE_DESTINATION_PUBKEY not set in env");

  const connection = new Connection(rpc, "confirmed");
  const usdcMint = new PublicKey(usdcMintStr);
  const feeDest = new PublicKey(feeDestStr);
  const admin = loadKeypair(adminPath);

  const ata = getAssociatedTokenAddressSync(usdcMint, feeDest, true);
  console.log(`[create-fee-destination-ata] RPC:      ${rpc}`);
  console.log(`[create-fee-destination-ata] USDC:     ${usdcMint.toBase58()}`);
  console.log(`[create-fee-destination-ata] fee_dest: ${feeDest.toBase58()}`);
  console.log(`[create-fee-destination-ata] ATA:      ${ata.toBase58()}`);
  console.log(`[create-fee-destination-ata] admin:    ${admin.publicKey.toBase58()}`);

  const existing = await connection.getAccountInfo(ata);
  if (existing) {
    console.log(`[create-fee-destination-ata] ATA already exists — nothing to do.`);
    return;
  }

  const adminBal = await connection.getBalance(admin.publicKey);
  console.log(`[create-fee-destination-ata] admin SOL: ${(adminBal / 1e9).toFixed(4)}`);
  if (adminBal < 5_000_000) {
    throw new Error(
      `admin SOL balance (${adminBal} lamports) < 0.005 SOL — top up before retrying.`,
    );
  }

  const ix = createAssociatedTokenAccountInstruction(
    admin.publicKey, // payer
    ata,
    feeDest,         // owner
    usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
    commitment: "confirmed",
  });
  console.log(`[create-fee-destination-ata] tx: ${sig}`);
  console.log(`[create-fee-destination-ata] done — ATA created.`);
}

main().catch((err) => {
  console.error("[create-fee-destination-ata] FATAL:", err);
  process.exit(1);
});
