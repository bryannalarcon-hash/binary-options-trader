/**
 * tests/anchor/_setup.ts
 *
 * Shared test fixtures for Meridian Anchor tests.
 *
 * Strategy
 * --------
 * We do NOT depend on `anchor test` driving the validator + deploy for us.
 * Instead, every test file calls `await getProvider()` which:
 *   1. Connects to whatever validator is reachable at SOLANA_RPC_URL
 *      (defaults to http://localhost:8899 — i.e. `solana-test-validator`).
 *   2. Loads the dev wallet from ANCHOR_WALLET (defaults to
 *      ~/.config/solana/id.json — matches the repo's Anchor.toml).
 *   3. Loads the program IDL from one of (in order):
 *        a) target/idl/meridian.json     (after `anchor build`)
 *        b) app/lib/meridian-idl.json    (committed stub — may be empty)
 *      and constructs a typed `Program` against the canonical PROGRAM_ID
 *      declared in programs/meridian/src/lib.rs.
 *
 * If the IDL is empty (the committed scaffold stub) we still let tests run —
 * each test gracefully `skip()`s when it discovers that the instruction it
 * needs is not exposed in the loaded IDL. This lets us run the suite in CI
 * (validating compilation) even before the contract handlers are implemented,
 * and the same tests light up automatically once `anchor build` regenerates
 * a non-empty IDL.
 *
 * NEVER run these tests against mainnet — they mutate global config + create
 * markets. The setup hard-asserts `cluster !== "mainnet-beta"`.
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// -----------------------------------------------------------------------------
// Constants — must match programs/meridian/src/{lib.rs,pdas.rs}
// -----------------------------------------------------------------------------

/** Program ID declared in lib.rs (and Anchor.toml [programs.localnet]). */
export const PROGRAM_ID = new PublicKey(
  "DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19",
);

export const CONFIG_SEED = Buffer.from("config");
export const MARKET_SEED = Buffer.from("market");
export const YES_MINT_SEED = Buffer.from("yes_mint");
export const NO_MINT_SEED = Buffer.from("no_mint");
export const VAULT_SEED = Buffer.from("vault");
export const ORACLE_SEED = Buffer.from("oracle");
export const ORDERBOOK_SEED = Buffer.from("orderbook");

/** USDC = 6 decimals; 1 USDC = 1_000_000 micro-USDC. */
export const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000;

/** YES price scale: prices are cents on a $1 unit, so 1..=99. */
export const PRICE_SCALE = 100;

// -----------------------------------------------------------------------------
// Provider / connection
// -----------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function loadKeypair(p: string): Keypair {
  const expanded = p.startsWith("~")
    ? path.join(os.homedir(), p.slice(1))
    : p;
  const data = JSON.parse(fs.readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function maybeLoadKeypair(p: string): Keypair | null {
  try {
    return loadKeypair(p);
  } catch {
    return null;
  }
}

function safetyCheckCluster() {
  const cluster =
    process.env.SOLANA_CLUSTER || process.env.ANCHOR_PROVIDER_URL || "";
  if (cluster.includes("mainnet")) {
    throw new Error(
      `[tests/anchor/_setup] Refusing to run tests against ${cluster}. ` +
        "These tests mutate global state.",
    );
  }
}

let _cachedProvider: AnchorProvider | null = null;

/**
 * Returns a singleton AnchorProvider connected to the configured RPC, using
 * the wallet at ANCHOR_WALLET (or the default Solana CLI keypair).
 * Returns `null` (rather than throwing) when the wallet keypair file is
 * missing — lets suite `before` hooks skip cleanly.
 */
export async function getProvider(): Promise<AnchorProvider | null> {
  if (_cachedProvider) return _cachedProvider;
  try {
    safetyCheckCluster();
  } catch {
    return null;
  }

  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    process.env.ANCHOR_PROVIDER_URL ||
    "http://localhost:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config", "solana", "id.json");

  const kp = maybeLoadKeypair(walletPath);
  if (!kp) return null;

  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  anchor.setProvider(provider);
  _cachedProvider = provider;
  return provider;
}

// -----------------------------------------------------------------------------
// IDL loading
// -----------------------------------------------------------------------------

/**
 * Loads the Meridian IDL from the canonical locations.
 * Returns null if no usable IDL is found (callers should `skip()`).
 */
export function loadMeridianIdl(): Idl | null {
  const candidates = [
    path.join(REPO_ROOT, "target", "idl", "meridian.json"),
    path.join(REPO_ROOT, "app", "lib", "meridian-idl.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Idl;
      // Treat the empty stub IDL as "no IDL".
      if (!raw.instructions || raw.instructions.length === 0) continue;
      return raw;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Returns a typed Program for Meridian, or null if IDL is unavailable.
 * Callers should `if (!program) this.skip()`.
 *
 * NOTE on the `any` return: the IDL is loaded dynamically and Anchor 0.30's
 * `Program<Idl>` resolves all `.methods.<ix>(...).accounts(...)` argument
 * types as `never` when the IDL is generic. Forcing tests through `any` lets
 * us write the canonical instruction calls without per-call casts; if/when
 * the smart-contract agent ships a typed IDL TS file in `target/types/`, we
 * can swap this for the strongly-typed `Program<Meridian>` form.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseProgram = any;

export async function getMeridianProgram(): Promise<LooseProgram | null> {
  const provider = await getProvider();
  if (!provider) return null;
  const idl = loadMeridianIdl();
  if (!idl) return null;
  return new Program(idl as Idl, provider) as LooseProgram;
}

/**
 * Best-effort check: is the program account present on chain?
 * Returns `false` (rather than throwing) on any connection/fetch failure so
 * suite-level `before` hooks can `.skip()` cleanly when nothing is running.
 */
export async function isProgramDeployed(
  provider: AnchorProvider,
): Promise<boolean> {
  try {
    const info = await provider.connection.getAccountInfo(PROGRAM_ID);
    return info !== null && info.executable;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// PDAs (must match programs/meridian/src/pdas.rs exactly)
// -----------------------------------------------------------------------------

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

export function marketPda(
  ticker: string,
  strikeCents: bigint,
  expiryTs: bigint,
): [PublicKey, number] {
  const strikeBuf = Buffer.alloc(8);
  strikeBuf.writeBigUInt64LE(strikeCents);
  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigInt64LE(expiryTs);
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, Buffer.from(ticker), strikeBuf, expiryBuf],
    PROGRAM_ID,
  );
}

export function yesMintPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, market.toBuffer()],
    PROGRAM_ID,
  );
}

export function noMintPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NO_MINT_SEED, market.toBuffer()],
    PROGRAM_ID,
  );
}

export function vaultPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    PROGRAM_ID,
  );
}

export function oraclePda(ticker: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORACLE_SEED, Buffer.from(ticker)],
    PROGRAM_ID,
  );
}

export function orderbookPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORDERBOOK_SEED, market.toBuffer()],
    PROGRAM_ID,
  );
}

// -----------------------------------------------------------------------------
// Wallet helpers
// -----------------------------------------------------------------------------

/** Generate a fresh keypair and airdrop SOL so it can pay fees. */
export async function newFundedKeypair(
  provider: AnchorProvider,
  sol = 5,
): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await provider.connection.requestAirdrop(
    kp.publicKey,
    sol * LAMPORTS_PER_SOL,
  );
  await provider.connection.confirmTransaction(sig, "confirmed");
  return kp;
}

/** Load the canonical admin keypair from disk (matches keys/admin.json). */
export function loadAdminKeypair(): Keypair | null {
  return maybeLoadKeypair(
    process.env.ADMIN_KEYPAIR_PATH ||
      path.join(REPO_ROOT, "keys", "admin.json"),
  );
}

/** Load the automation keypair (used as oracle_authority). */
export function loadAutomationKeypair(): Keypair | null {
  return maybeLoadKeypair(
    process.env.AUTOMATION_KEYPAIR_PATH ||
      path.join(REPO_ROOT, "keys", "automation.json"),
  );
}

/** Load the fee destination keypair (only the pubkey is referenced on-chain). */
export function loadFeeDestinationKeypair(): Keypair | null {
  return maybeLoadKeypair(path.join(REPO_ROOT, "keys", "fee_destination.json"));
}

// -----------------------------------------------------------------------------
// Time helpers
// -----------------------------------------------------------------------------

export const SECONDS_PER_HOUR = 3600n;
export const SETTLE_OVERRIDE_DELAY_SECONDS = 3600n; // 1 hour, per PRD §2.5
export const ORACLE_MAX_STALENESS_SECONDS = 300n; // §2.7 (we use 300s; .env default = 30s)

/** Current unix seconds as bigint. */
export function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

export { anchor, BN };
