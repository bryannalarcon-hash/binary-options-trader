import * as fs from "fs";

import {
  AnchorProvider,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";

import { env } from "../env";
import { ctx } from "../logger";

const log = ctx("anchor");

/**
 * Load a Solana keypair from either:
 *   - a JSON file (Anchor / Solana CLI format, array of 64 bytes), OR
 *   - a base64-encoded env var (when running on Railway / containers where
 *     the filesystem is ephemeral).
 *
 * Env var lookup order:
 *   1. If `path` matches one of the well-known keypair paths in the .env, we
 *      look up the corresponding `<NAME>_KEYPAIR_B64` env var first.
 *   2. If found, decode base64 → JSON array → Keypair.
 *   3. Otherwise fall back to reading from disk.
 */
export function loadKeypair(path: string): Keypair {
  // Try to detect which keypair this is from the path, then check for a
  // base64 override in env.
  const b64Key = detectKeypairEnvKey(path);
  if (b64Key) {
    const b64 = process.env[b64Key];
    if (b64 && b64.trim() !== "") {
      try {
        const json = Buffer.from(b64.trim(), "base64").toString("utf8");
        const arr = JSON.parse(json) as number[];
        if (!Array.isArray(arr) || arr.length !== 64) {
          throw new Error(`${b64Key} decoded to invalid keypair (length ${arr?.length})`);
        }
        log.info({ b64Key }, "loaded keypair from base64 env var");
        return Keypair.fromSecretKey(Uint8Array.from(arr));
      } catch (err) {
        throw new Error(
          `Failed to decode ${b64Key} as base64 keypair JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (!fs.existsSync(path)) {
    throw new Error(
      `Keypair not found at ${path}${b64Key ? ` (and no ${b64Key} env var set)` : ""}`,
    );
  }
  const raw = fs.readFileSync(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/**
 * Map a keypair file path to the env-var name that may contain its base64
 * encoding. Matches by basename so paths can be absolute or relative.
 */
function detectKeypairEnvKey(p: string): string | null {
  const lower = p.toLowerCase();
  if (lower.endsWith("admin.json")) return "ADMIN_KEYPAIR_B64";
  if (lower.endsWith("automation.json")) return "AUTOMATION_KEYPAIR_B64";
  if (lower.endsWith("fee_destination.json")) return "FEE_DESTINATION_KEYPAIR_B64";
  return null;
}

/**
 * Read the shared IDL written by the smart-contract agent at
 * `app/lib/meridian-idl.json`. If the file is empty (instructions: []) we
 * still return it — callers must check `idl.instructions.length` before use.
 */
export function loadIdl(): Idl {
  // Resolve from package root (automation/) up to the app/ peer.
  const idlPath = require.resolve("../../../app/lib/meridian-idl.json");
  const raw = fs.readFileSync(idlPath, "utf8");
  return JSON.parse(raw) as Idl;
}

export interface AnchorContext {
  connection: Connection;
  wallet: Wallet;
  provider: AnchorProvider;
  program: Program;
  programId: PublicKey;
}

/**
 * Build the Anchor context (connection + wallet + program) for a given signer
 * keypair path. Throws a friendly error if the on-chain program is missing.
 */
export function buildAnchorContext(keypairPath: string): AnchorContext {
  const idl = loadIdl();
  if (!idl.instructions || idl.instructions.length === 0) {
    throw new Error(
      "IDL has no instructions — has the contract agent published `app/lib/meridian-idl.json` yet?",
    );
  }
  // Anchor 0.30 reads programId from idl.address. Allow env override by
  // mutating the parsed IDL before constructing the Program.
  const idlAny = idl as Idl & { address?: string; metadata?: { address?: string } };
  const programIdStr =
    env.programId ||
    idlAny.address ||
    idlAny.metadata?.address ||
    "";
  if (!programIdStr) {
    throw new Error(
      "No program ID — set MERIDIAN_PROGRAM_ID in .env or populate idl.address",
    );
  }
  idlAny.address = programIdStr;
  const programId = new PublicKey(programIdStr);

  const connection = new Connection(env.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: env.wsUrl,
    // Devnet RPCs (Helius free tier) throttle confirmation polling under load;
    // the default 30s timeout can fire even though the tx confirmed on-chain.
    // Give confirmations more headroom so we don't abort a multi-step flow.
    confirmTransactionInitialTimeout: 120_000,
  });
  const kp = loadKeypair(keypairPath);
  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idlAny, provider);

  log.debug(
    { programId: programId.toBase58(), wallet: kp.publicKey.toBase58() },
    "anchor context ready",
  );

  return { connection, wallet, provider, program, programId };
}

/** Returns true if the program is deployed at `programId` on the current RPC. */
export async function isProgramDeployed(
  connection: Connection,
  programId: PublicKey,
): Promise<boolean> {
  try {
    const acct = await connection.getAccountInfo(programId);
    return acct !== null && acct.executable;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), programId: programId.toBase58() },
      "RPC unreachable while checking program deployment",
    );
    return false;
  }
}
