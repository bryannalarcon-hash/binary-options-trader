import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

/**
 * PDA seed builders. Mirror of `programs/meridian/src/pdas.rs`.
 *
 * Keep these in lockstep with the Rust seeds — any drift here makes every
 * subsequent CPI fail with "AccountNotFound" or "ConstraintSeeds".
 */
export const CONFIG_SEED = Buffer.from("config");
export const MARKET_SEED = Buffer.from("market");
export const YES_MINT_SEED = Buffer.from("yes_mint");
export const NO_MINT_SEED = Buffer.from("no_mint");
export const VAULT_SEED = Buffer.from("vault");
export const VAULT_AUTHORITY_SEED = Buffer.from("vault_authority");
export const ORACLE_SEED = Buffer.from("oracle");
export const ORDERBOOK_SEED = Buffer.from("orderbook");

/** u64 little-endian buffer (8 bytes). */
function u64Le(value: number | bigint): Buffer {
  return new BN(value.toString()).toArrayLike(Buffer, "le", 8);
}

/** i64 little-endian buffer (8 bytes). BN handles two's-complement via toTwos. */
function i64Le(value: number | bigint): Buffer {
  const bn = new BN(value.toString());
  return bn.toTwos(64).toArrayLike(Buffer, "le", 8);
}

export function configPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

export function marketPda(
  programId: PublicKey,
  ticker: string,
  strike: number | bigint,
  expiryTs: number | bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, Buffer.from(ticker, "utf8"), u64Le(strike), i64Le(expiryTs)],
    programId,
  );
}

export function yesMintPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, market.toBuffer()],
    programId,
  );
}

export function noMintPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NO_MINT_SEED, market.toBuffer()],
    programId,
  );
}

export function vaultPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    programId,
  );
}

/**
 * Vault authority PDA. The Rust contract may use the market PDA itself as the
 * vault authority OR a dedicated `vault_authority` PDA — both patterns appear
 * in the PRD. We expose both helpers; callers pick based on the final IDL.
 */
export function vaultAuthorityPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_AUTHORITY_SEED, market.toBuffer()],
    programId,
  );
}

export function oraclePda(
  programId: PublicKey,
  ticker: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORACLE_SEED, Buffer.from(ticker, "utf8")],
    programId,
  );
}

export function orderbookPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORDERBOOK_SEED, market.toBuffer()],
    programId,
  );
}
