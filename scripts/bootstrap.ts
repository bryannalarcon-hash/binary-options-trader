#!/usr/bin/env tsx
/**
 * Bootstrap helper for localnet.
 *
 * Assumes:
 *   - solana-test-validator is up on http://localhost:8899
 *   - the program has already been deployed via `solana program deploy`
 *   - USDC_MINT env var is set to a fresh SPL token mint (6 decimals)
 *
 * Performs:
 *   1. initialize_config(admin=admin, fee_destination, oracle_authority=admin, usdc_mint)
 *      — idempotent: skipped if config PDA already exists.
 *   2. For each MAG7 ticker: writes a starting price into the mock oracle PDA.
 *      Tries Hermes first; falls back to a hardcoded snapshot if Hermes is
 *      unreachable from the dev box.
 *   3. For each ticker × strike: bundles `create_strike_market` +
 *      `init_market_books` into one transaction. Idempotent on
 *      "AccountAlreadyInitialized".
 *   4. Mints 1,000,000 USDC into the dev wallet ATA so the user can trade.
 *   5. Prints a summary block at the end.
 *
 * Invoked by `scripts/bootstrap-localnet.sh` after deploying the program.
 */

import * as fs from "fs";
import * as path from "path";

import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as dotenv from "dotenv";

// ----------------------------------------------------------------------------
// Env loading — .env.local wins over .env (no overwriting of existing keys).
// ----------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env.local") });
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const IDL_PATH = path.join(REPO_ROOT, "app", "lib", "meridian-idl.json");
const ADMIN_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR_PATH || path.join(REPO_ROOT, "keys", "admin.json");
const RPC_URL = process.env.SOLANA_RPC_URL || "http://localhost:8899";

const MAG7_TICKERS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
] as const;
type Ticker = (typeof MAG7_TICKERS)[number];

// Fallback prices in USD (used if Hermes is unreachable from the dev box).
// Roughly representative spot — accuracy doesn't matter for a local demo.
const FALLBACK_PRICES_USD: Record<Ticker, number> = {
  AAPL: 220.0,
  MSFT: 430.0,
  GOOGL: 175.0,
  AMZN: 195.0,
  NVDA: 140.0,
  META: 580.0,
  TSLA: 320.0,
};

const PYTH_FEEDS: Record<Ticker, string> = {
  AAPL: process.env.PYTH_FEED_AAPL || "",
  MSFT: process.env.PYTH_FEED_MSFT || "",
  GOOGL: process.env.PYTH_FEED_GOOGL || "",
  AMZN: process.env.PYTH_FEED_AMZN || "",
  NVDA: process.env.PYTH_FEED_NVDA || "",
  META: process.env.PYTH_FEED_META || "",
  TSLA: process.env.PYTH_FEED_TSLA || "",
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

function loadIdl(): Idl {
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;
}

const CONFIG_SEED = Buffer.from("config");
const MARKET_SEED = Buffer.from("market");
const YES_MINT_SEED = Buffer.from("yes_mint");
const NO_MINT_SEED = Buffer.from("no_mint");
const ORACLE_SEED = Buffer.from("oracle");
const ORDERBOOK_SEED = Buffer.from("orderbook");
const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");

function u64Le(value: number | bigint): Buffer {
  return new BN(value.toString()).toArrayLike(Buffer, "le", 8);
}
function i64Le(value: number | bigint): Buffer {
  const bn = new BN(value.toString());
  return bn.toTwos(64).toArrayLike(Buffer, "le", 8);
}

function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}
function marketPda(
  programId: PublicKey,
  ticker: string,
  strike: number,
  expiryTs: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, Buffer.from(ticker, "utf8"), u64Le(strike), i64Le(expiryTs)],
    programId,
  )[0];
}
function yesMintPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, market.toBuffer()],
    programId,
  )[0];
}
function noMintPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [NO_MINT_SEED, market.toBuffer()],
    programId,
  )[0];
}
function oraclePda(programId: PublicKey, ticker: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ORACLE_SEED, Buffer.from(ticker, "utf8")],
    programId,
  )[0];
}
function orderbookPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ORDERBOOK_SEED, market.toBuffer()],
    programId,
  )[0];
}
function usdcEscrowPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [USDC_ESCROW_SEED, market.toBuffer()],
    programId,
  )[0];
}
function yesEscrowPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [YES_ESCROW_SEED, market.toBuffer()],
    programId,
  )[0];
}

/** Strike grid: ±3/6/9% rounded to nearest $10 (1000 cents). */
function computeStrikes(previousCloseCents: number): number[] {
  const out = new Set<number>();
  const pcts = [-9, -6, -3, 3, 6, 9];
  for (const pct of pcts) {
    const raw = previousCloseCents * (1 + pct / 100);
    const step = 1000;
    const rounded = Math.round(raw / step) * step;
    if (rounded > 0) out.add(rounded);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** Expiry: today 4:00 PM America/New_York → unix seconds. */
function todayExpiryTsSeconds(): number {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  // Offset = NY-as-UTC minus actual UTC.
  const nyAsUtc = Date.UTC(
    map.year ?? 1970,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    map.hour === 24 ? 0 : (map.hour ?? 0),
    map.minute ?? 0,
    map.second ?? 0,
  );
  const offsetMin = Math.round((nyAsUtc - now.getTime()) / 60_000);
  const target = Date.UTC(map.year!, map.month! - 1, map.day!, 16, 0, 0);
  return Math.floor((target - offsetMin * 60_000) / 1000);
}

async function fetchHermes(): Promise<Partial<Record<Ticker, number>>> {
  const entries = Object.entries(PYTH_FEEDS).filter(([, id]) => id);
  if (entries.length === 0) return {};
  const ids = entries.map(([, id]) => id);
  const url = `https://hermes.pyth.network/v2/updates/price/latest?${ids
    .map((i) => `ids[]=${encodeURIComponent(i)}`)
    .join("&")}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`hermes ${res.status}`);
    }
    const body = (await res.json()) as {
      parsed?: Array<{
        id: string;
        price: { price: string; expo: number };
      }>;
    };
    const byId = new Map<string, number>();
    for (const e of body.parsed ?? []) {
      const id = e.id.startsWith("0x") ? e.id : `0x${e.id}`;
      const priceUsd = Number(e.price.price) * Math.pow(10, e.price.expo);
      byId.set(id, priceUsd);
    }
    const out: Partial<Record<Ticker, number>> = {};
    for (const [ticker, id] of entries) {
      const norm = id.startsWith("0x") ? id : `0x${id}`;
      const v = byId.get(norm);
      if (v && Number.isFinite(v) && v > 0) out[ticker as Ticker] = v;
    }
    return out;
  } catch (err) {
    console.warn(
      `[bootstrap] Hermes fetch failed (${(err as Error).message}), using fallback prices`,
    );
    return {};
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isAlreadyInitialized(err: unknown): boolean {
  const m = errMsg(err).toLowerCase();
  return (
    m.includes("already in use") ||
    m.includes("custom program error: 0x0") ||
    m.includes("accountalreadyinuse")
  );
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[bootstrap] starting");
  console.log(`[bootstrap]   RPC: ${RPC_URL}`);
  console.log(`[bootstrap]   admin keypair: ${ADMIN_KEYPAIR_PATH}`);

  const programIdStr = process.env.MERIDIAN_PROGRAM_ID;
  if (!programIdStr) throw new Error("MERIDIAN_PROGRAM_ID not set in env");
  const programId = new PublicKey(programIdStr);
  console.log(`[bootstrap]   programId: ${programId.toBase58()}`);

  const usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) throw new Error("USDC_MINT not set in env");
  const usdcMint = new PublicKey(usdcMintStr);
  console.log(`[bootstrap]   usdcMint:  ${usdcMint.toBase58()}`);

  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`[bootstrap]   admin pubkey: ${admin.publicKey.toBase58()}`);

  // Default dev wallet — the user funds 100 USDC into THIS one for Phantom testing.
  const devWalletPath =
    process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const devWallet = loadKeypair(devWalletPath);
  console.log(`[bootstrap]   dev wallet: ${devWallet.publicKey.toBase58()}`);

  const feeDest = process.env.FEE_DESTINATION_PUBKEY
    ? new PublicKey(process.env.FEE_DESTINATION_PUBKEY)
    : admin.publicKey;

  const connection = new Connection(RPC_URL, "confirmed");

  // Sanity: USDC mint exists.
  try {
    const m = await getMint(connection, usdcMint);
    console.log(
      `[bootstrap]   USDC mint OK — decimals=${m.decimals}, supply=${m.supply.toString()}`,
    );
  } catch (err) {
    throw new Error(
      `USDC mint ${usdcMint.toBase58()} not found on RPC ${RPC_URL}: ${errMsg(err)}`,
    );
  }

  const idl = loadIdl();
  const idlAny = idl as Idl & { address?: string };
  idlAny.address = programId.toBase58();
  const provider = new AnchorProvider(
    connection,
    new Wallet(admin),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  const program = new Program(idlAny, provider);

  // ------------------------------------------------------------------------
  // Step 1: initialize_config (idempotent)
  // ------------------------------------------------------------------------
  const config = configPda(programId);
  const configAcct = await connection.getAccountInfo(config);
  if (configAcct) {
    console.log("[bootstrap] step 1 — config already initialized, skipping");
  } else {
    console.log("[bootstrap] step 1 — initializing config");
    const sig = await (program.methods as any)
      .initializeConfig(
        admin.publicKey,
        feeDest,
        admin.publicKey, // oracle_authority = admin (v1)
        usdcMint,
      )
      .accounts({
        config,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`[bootstrap]   tx: ${sig}`);
  }

  // ------------------------------------------------------------------------
  // Step 2: populate oracles (Hermes → fallback)
  // ------------------------------------------------------------------------
  console.log("[bootstrap] step 2 — populating MAG7 oracles");
  const hermes = await fetchHermes();
  const usedPrices: Record<Ticker, number> = { ...FALLBACK_PRICES_USD };
  for (const ticker of MAG7_TICKERS) {
    const fromHermes = hermes[ticker];
    if (fromHermes && fromHermes > 0) usedPrices[ticker] = fromHermes;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const ticker of MAG7_TICKERS) {
    const priceUsd = usedPrices[ticker];
    const priceCents = Math.round(priceUsd * 100);
    // 5 cents conf — well below the 0.5% confidence threshold the contract enforces.
    const confCents = Math.max(1, Math.floor(priceCents * 0.001));
    const oracle = oraclePda(programId, ticker);

    try {
      const sig = await (program.methods as any)
        .updateOracle(
          ticker,
          new BN(priceCents),
          new BN(confCents),
          new BN(nowSec),
          -2,
        )
        .accounts({
          config,
          oracleAuthority: admin.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(
        `[bootstrap]   ${ticker.padEnd(6)} price=$${priceUsd.toFixed(2)} cents=${priceCents}  tx=${sig.slice(0, 12)}…`,
      );
    } catch (err) {
      console.error(`[bootstrap]   ${ticker}: update_oracle FAILED — ${errMsg(err)}`);
      throw err;
    }
  }

  // ------------------------------------------------------------------------
  // Step 3: create markets — for each ticker × strike, bundle create + init.
  // ------------------------------------------------------------------------
  console.log("[bootstrap] step 3 — creating markets");
  const expiryTs = todayExpiryTsSeconds();
  console.log(
    `[bootstrap]   expiry: ${expiryTs} (${new Date(expiryTs * 1000).toISOString()})`,
  );

  const created: Array<{ ticker: Ticker; strike: number; market: string }> = [];
  for (const ticker of MAG7_TICKERS) {
    const priceCents = Math.round(usedPrices[ticker] * 100);
    const strikes = computeStrikes(priceCents);
    for (const strike of strikes) {
      const market = marketPda(programId, ticker, strike, expiryTs);
      const yesMint = yesMintPda(programId, market);
      const noMint = noMintPda(programId, market);
      const oracle = oraclePda(programId, ticker);
      const vault = getAssociatedTokenAddressSync(
        usdcMint,
        market,
        true, // allow off-curve (market is a PDA)
      );
      const orderbook = orderbookPda(programId, market);
      const usdcEscrow = usdcEscrowPda(programId, market);
      const yesEscrow = yesEscrowPda(programId, market);

      // Skip if already created (idempotent).
      const existing = await connection.getAccountInfo(market);
      if (existing) {
        console.log(
          `[bootstrap]   ${ticker} @ $${(strike / 100).toFixed(2)} already exists — skipping`,
        );
        created.push({ ticker, strike, market: market.toBase58() });
        continue;
      }

      try {
        const createIx = await (program.methods as any)
          .createStrikeMarket(ticker, new BN(strike), new BN(expiryTs))
          .accounts({
            config,
            market,
            yesMint,
            noMint,
            usdcMint,
            vault,
            oracle,
            payer: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        const initIx = await (program.methods as any)
          .initMarketBooks()
          .accounts({
            market,
            yesMint,
            usdcMint,
            orderbook,
            usdcEscrow,
            yesEscrow,
            payer: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        const tx = new Transaction().add(createIx, initIx);
        const sig = await provider.sendAndConfirm(tx, [admin]);

        console.log(
          `[bootstrap]   ${ticker.padEnd(6)} @ $${(strike / 100).toFixed(2).padStart(7)}  market=${market.toBase58().slice(0, 8)}…  tx=${sig.slice(0, 12)}…`,
        );
        created.push({ ticker, strike, market: market.toBase58() });
      } catch (err) {
        if (isAlreadyInitialized(err)) {
          console.log(
            `[bootstrap]   ${ticker} @ $${(strike / 100).toFixed(2)} already exists (race), continuing`,
          );
          created.push({ ticker, strike, market: market.toBase58() });
        } else {
          console.error(
            `[bootstrap]   FAILED ${ticker} @ ${strike}: ${errMsg(err)}`,
          );
          // Don't abort — try the rest so a single failure doesn't tank the whole demo.
        }
      }
    }
  }

  // ------------------------------------------------------------------------
  // Step 4: fund the dev wallet with 100 USDC for testing trades.
  // ------------------------------------------------------------------------
  console.log("[bootstrap] step 4 — funding dev wallet with 100 USDC");
  const devAta = await createAssociatedTokenAccountIdempotent(
    connection,
    admin, // payer
    usdcMint,
    devWallet.publicKey,
  );
  await mintTo(
    connection,
    admin,
    usdcMint,
    devAta,
    admin, // admin owns the mint (created in bootstrap-localnet.sh)
    100 * 1_000_000,
  );
  console.log(
    `[bootstrap]   minted 100 USDC to dev wallet ATA ${devAta.toBase58()}`,
  );

  // ------------------------------------------------------------------------
  // Step 5: summary
  // ------------------------------------------------------------------------
  console.log("");
  console.log("============================================================");
  console.log("  Meridian bootstrap complete");
  console.log("============================================================");
  console.log(`  Program ID : ${programId.toBase58()}`);
  console.log(`  USDC mint  : ${usdcMint.toBase58()}`);
  console.log(`  Admin      : ${admin.publicKey.toBase58()}`);
  console.log(`  Dev wallet : ${devWallet.publicKey.toBase58()}  (+100 USDC)`);
  console.log(`  Markets    : ${created.length}`);
  for (const ticker of MAG7_TICKERS) {
    const forTicker = created.filter((m) => m.ticker === ticker);
    const strikes = forTicker
      .map((m) => `$${(m.strike / 100).toFixed(0)}`)
      .join(", ");
    console.log(`    ${ticker.padEnd(6)} ${forTicker.length} strikes: ${strikes}`);
  }
  console.log("============================================================");
}

main().catch((err) => {
  console.error("[bootstrap] FATAL:", errMsg(err));
  process.exit(1);
});
