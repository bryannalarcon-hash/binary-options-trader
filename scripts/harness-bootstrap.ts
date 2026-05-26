/**
 * scripts/harness-bootstrap.ts
 *
 * Minimal bootstrap to satisfy the pre-conditions of the harness-based suites
 * (tests/anchor/edge-cases.test.ts and integration.test.ts).
 *
 * Those suites' `tryBootstrap()` require:
 *   - validator reachable + program deployed (done by the test runner)
 *   - keys/admin.json, keys/automation.json, keys/fee_destination.json present
 *   - process.env.USDC_MINT pointing at a real 6-decimal mint
 *   - the on-chain Config initialized with:
 *        admin            = keys/admin.json
 *        oracle_authority = keys/automation.json   (update_oracle enforces this!)
 *        fee_destination  = keys/fee_destination.json
 *        usdc_mint        = the mint above
 *
 * Prints `USDC_MINT=<pubkey>` on the last stdout line so the shell runner can
 * eval it into the test environment.
 */
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const REPO_ROOT = path.resolve(__dirname, "..");
const RPC = process.env.SOLANA_RPC_URL || "http://localhost:8899";

function loadKp(p: string): Keypair {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expanded, "utf8")) as number[]),
  );
}

async function fund(conn: Connection, pk: PublicKey, sol = 100) {
  const bal = await conn.getBalance(pk);
  if (bal >= sol * LAMPORTS_PER_SOL * 0.1) return;
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function main() {
  const idlPath = path.join(REPO_ROOT, "app", "lib", "meridian-idl.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl & {
    address: string;
  };
  const programId = new PublicKey(idl.address);

  const admin = loadKp(path.join(REPO_ROOT, "keys", "admin.json"));
  const automation = loadKp(path.join(REPO_ROOT, "keys", "automation.json"));
  const feeDest = loadKp(path.join(REPO_ROOT, "keys", "fee_destination.json"));
  const devWallet = loadKp(path.join(os.homedir(), ".config", "solana", "id.json"));

  const conn = new Connection(RPC, "confirmed");

  // Fund all signers.
  for (const pk of [
    admin.publicKey,
    automation.publicKey,
    feeDest.publicKey,
    devWallet.publicKey,
  ]) {
    await fund(conn, pk, 100);
  }

  // Create a fresh 6-decimal USDC mint with admin as mint authority.
  const usdcMint = await createMint(conn, admin, admin.publicKey, null, 6);
  process.stderr.write(`[harness-bootstrap] USDC mint: ${usdcMint.toBase58()}\n`);

  const provider = new AnchorProvider(conn, new Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );

  const existing = await conn.getAccountInfo(config);
  if (existing) {
    process.stderr.write("[harness-bootstrap] config already initialized\n");
  } else {
    process.stderr.write(
      "[harness-bootstrap] initialize_config(admin, fee_dest, oracle_authority=automation, usdc_mint)\n",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (program.methods as any)
      .initializeConfig(
        admin.publicKey,
        feeDest.publicKey,
        automation.publicKey, // oracle_authority MUST be the automation key (harness signs with it)
        usdcMint,
      )
      .accounts({
        config,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    process.stderr.write("[harness-bootstrap] config initialized\n");
  }

  void BN;
  // The ONLY thing on stdout: the env line the runner evals.
  process.stdout.write(`USDC_MINT=${usdcMint.toBase58()}\n`);
}

main().catch((e) => {
  process.stderr.write(`[harness-bootstrap] FAILED: ${e?.message || e}\n`);
  process.exit(1);
});
