#!/usr/bin/env tsx
/**
 * One-off: call `migrate_config` on devnet to grow a pre-risk-params Config
 * account to the current layout. Admin-signed. Idempotent.
 *
 *   pnpm --filter automation exec tsx ../scripts/migrate-config-devnet.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

const REPO_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.MERIDIAN_PROGRAM_ID || "DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19",
);
const ADMIN_PATH = process.env.ADMIN_KEYPAIR_PATH || path.join(REPO_ROOT, "keys", "admin.json");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const admin = loadKeypair(ADMIN_PATH);
  const conn = new Connection(RPC, "confirmed");
  const idl = require(path.join(REPO_ROOT, "app/lib/meridian-idl.json")) as Idl & { address?: string };
  idl.address = PROGRAM_ID.toBase58();
  const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const before = await conn.getAccountInfo(config);
  console.log(`[migrate] RPC ${RPC}`);
  console.log(`[migrate] admin ${admin.publicKey.toBase58()}`);
  console.log(`[migrate] Config ${config.toBase58()} — before: ${before?.data.length ?? "MISSING"} bytes`);

  const sig = await (program.methods as any)
    .migrateConfig()
    .accounts({ config, admin: admin.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`[migrate] migrate_config sig: ${sig}`);

  const after = await conn.getAccountInfo(config);
  console.log(`[migrate] Config after: ${after?.data.length ?? "MISSING"} bytes`);
  if (after && after.data.length >= 148) {
    console.log(
      `[migrate] max_staleness_secs=${after.data.readBigInt64LE(138)} max_confidence_bps=${after.data.readUInt16LE(146)}`,
    );
  }
  // Final proof: decode via the typed program (fails if layout is wrong).
  const cfg: any = await (program.account as any).config.fetch(config);
  console.log(
    `[migrate] decoded OK — admin=${cfg.admin.toBase58()} paused=${cfg.paused} maxStaleness=${cfg.maxStalenessSecs} maxConfBps=${cfg.maxConfidenceBps}`,
  );
}

main().catch((e) => {
  console.error("[migrate] FAILED:", e);
  process.exit(1);
});
