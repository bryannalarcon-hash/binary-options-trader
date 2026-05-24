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

/** Load a Solana keypair from a JSON file (Anchor / Solana CLI format). */
export function loadKeypair(path: string): Keypair {
  if (!fs.existsSync(path)) {
    throw new Error(`Keypair not found at ${path}`);
  }
  const raw = fs.readFileSync(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
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
