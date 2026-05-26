#!/usr/bin/env tsx
/**
 * Bootstrap helper for DEVNET.
 *
 * Differences from `bootstrap.ts` (localnet):
 *   - Uses existing devnet USDC mint (Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr,
 *     authority held by Circle — we cannot mint to the dev wallet from here;
 *     instead, the user funds via https://spl-token-faucet.com/?token-name=USDC-Dev).
 *   - REQUIRES Hermes prices — falls back only in catastrophic failure modes,
 *     but logs a loud warning if it does. The deployed demo should always use
 *     real Pyth prices.
 *   - Does NOT mint 100 USDC into the dev wallet (impossible on devnet).
 *
 * Assumes:
 *   - .env points at devnet (or Helius devnet)
 *   - the meridian program is already deployed at MERIDIAN_PROGRAM_ID
 *   - admin wallet has ~0.5 SOL for the markets it creates
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
  getAssociatedTokenAddressSync,
  getMint,
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
// Env loading — only .env (no .env.local for devnet)
// ----------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const IDL_PATH = path.join(REPO_ROOT, "app", "lib", "meridian-idl.json");
const ADMIN_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR_PATH || path.join(REPO_ROOT, "keys", "admin.json");
const RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

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

// Last-resort fallback prices only — should NEVER fire in a healthy run.
const EMERGENCY_FALLBACK_PRICES_USD: Record<Ticker, number> = {
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

/** Expiry: today (or next weekday) 4:00 PM America/New_York → unix seconds. */
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
  if (entries.length === 0) {
    console.warn("[bootstrap-devnet] no Pyth feed IDs in env — cannot fetch real prices");
    return {};
  }
  const ids = entries.map(([, id]) => id);
  const url = `https://hermes.pyth.network/v2/updates/price/latest?${ids
    .map((i) => `ids[]=${encodeURIComponent(i)}`)
    .join("&")}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`hermes ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      parsed?: Array<{
        id: string;
        price: { price: string; expo: number; publish_time?: number };
      }>;
    };
    const byId = new Map<string, { priceUsd: number; publishTime: number }>();
    for (const e of body.parsed ?? []) {
      const id = e.id.startsWith("0x") ? e.id : `0x${e.id}`;
      const priceUsd = Number(e.price.price) * Math.pow(10, e.price.expo);
      byId.set(id, { priceUsd, publishTime: e.price.publish_time ?? 0 });
    }
    const out: Partial<Record<Ticker, number>> = {};
    for (const [ticker, id] of entries) {
      const norm = id.startsWith("0x") ? id : `0x${id}`;
      const entry = byId.get(norm);
      if (entry && Number.isFinite(entry.priceUsd) && entry.priceUsd > 0) {
        out[ticker as Ticker] = entry.priceUsd;
      }
    }
    console.log(
      `[bootstrap-devnet] Hermes returned ${Object.keys(out).length}/${entries.length} real prices`,
    );
    return out;
  } catch (err) {
    console.warn(
      `[bootstrap-devnet] Hermes fetch FAILED (${(err as Error).message}). Using emergency fallback prices.`,
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

async function main(): Promise<void> {
  console.log("[bootstrap-devnet] starting");
  console.log(`[bootstrap-devnet]   RPC: ${RPC_URL}`);
  console.log(`[bootstrap-devnet]   admin keypair: ${ADMIN_KEYPAIR_PATH}`);

  const programIdStr = process.env.MERIDIAN_PROGRAM_ID;
  if (!programIdStr) throw new Error("MERIDIAN_PROGRAM_ID not set in env");
  const programId = new PublicKey(programIdStr);
  console.log(`[bootstrap-devnet]   programId: ${programId.toBase58()}`);

  const usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) throw new Error("USDC_MINT not set in env");
  const usdcMint = new PublicKey(usdcMintStr);
  console.log(`[bootstrap-devnet]   usdcMint:  ${usdcMint.toBase58()}`);

  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  console.log(`[bootstrap-devnet]   admin pubkey: ${admin.publicKey.toBase58()}`);

  const devWalletPath =
    process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const devWallet = loadKeypair(devWalletPath);
  console.log(`[bootstrap-devnet]   dev wallet: ${devWallet.publicKey.toBase58()}`);

  const feeDest = process.env.FEE_DESTINATION_PUBKEY
    ? new PublicKey(process.env.FEE_DESTINATION_PUBKEY)
    : admin.publicKey;

  const connection = new Connection(RPC_URL, "confirmed");

  // Sanity: program exists on this RPC.
  const progAcct = await connection.getAccountInfo(programId);
  if (!progAcct || !progAcct.executable) {
    throw new Error(
      `program ${programId.toBase58()} is NOT deployed at ${RPC_URL} — deploy first`,
    );
  }
  console.log(`[bootstrap-devnet]   program deploy verified (${progAcct.data.length} bytes)`);

  // Sanity: USDC mint exists.
  try {
    const m = await getMint(connection, usdcMint);
    console.log(
      `[bootstrap-devnet]   USDC mint OK — decimals=${m.decimals}, supply=${m.supply.toString()}`,
    );
  } catch (err) {
    throw new Error(
      `USDC mint ${usdcMint.toBase58()} not found on RPC ${RPC_URL}: ${errMsg(err)}`,
    );
  }

  // Sanity: admin has SOL.
  const adminBal = await connection.getBalance(admin.publicKey);
  console.log(`[bootstrap-devnet]   admin SOL balance: ${(adminBal / 1e9).toFixed(4)}`);
  if (adminBal < 0.1 * 1e9) {
    throw new Error("admin wallet has < 0.1 SOL — cannot pay for transactions");
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
    console.log("[bootstrap-devnet] step 1 — config already initialized, skipping");
  } else {
    console.log("[bootstrap-devnet] step 1 — initializing config");
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
    console.log(`[bootstrap-devnet]   tx: ${sig}`);
  }

  // ------------------------------------------------------------------------
  // Step 2: populate oracles with REAL PYTH PRICES
  // ------------------------------------------------------------------------
  console.log("[bootstrap-devnet] step 2 — populating MAG7 oracles with real Hermes prices");
  const hermes = await fetchHermes();
  const usedPrices: Record<Ticker, number> = { ...EMERGENCY_FALLBACK_PRICES_USD };
  const priceSource: Record<Ticker, "hermes" | "fallback"> = {} as any;
  for (const ticker of MAG7_TICKERS) {
    const fromHermes = hermes[ticker];
    if (fromHermes && fromHermes > 0) {
      usedPrices[ticker] = fromHermes;
      priceSource[ticker] = "hermes";
    } else {
      priceSource[ticker] = "fallback";
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const ticker of MAG7_TICKERS) {
    const priceUsd = usedPrices[ticker];
    const priceCents = Math.round(priceUsd * 100);
    // 1% confidence on devnet (relaxed from 0.5% on localnet) — equity feeds
    // are sometimes coarser than crypto feeds.
    const confCents = Math.max(1, Math.floor(priceCents * 0.005));
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
        `[bootstrap-devnet]   ${ticker.padEnd(6)} $${priceUsd.toFixed(2)} (${priceSource[ticker]})  tx=${sig.slice(0, 12)}…`,
      );
    } catch (err) {
      console.error(
        `[bootstrap-devnet]   ${ticker}: update_oracle FAILED — ${errMsg(err)}`,
      );
      throw err;
    }
  }

  // ------------------------------------------------------------------------
  // Step 3: create markets — for each ticker × strike.
  // ------------------------------------------------------------------------
  console.log("[bootstrap-devnet] step 3 — creating markets");
  const expiryTs = todayExpiryTsSeconds();
  console.log(
    `[bootstrap-devnet]   expiry: ${expiryTs} (${new Date(expiryTs * 1000).toISOString()})`,
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

      const existing = await connection.getAccountInfo(market);
      if (existing) {
        console.log(
          `[bootstrap-devnet]   ${ticker} @ $${(strike / 100).toFixed(2)} already exists — skipping`,
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
          `[bootstrap-devnet]   ${ticker.padEnd(6)} @ $${(strike / 100).toFixed(2).padStart(7)}  market=${market.toBase58().slice(0, 8)}…  tx=${sig.slice(0, 12)}…`,
        );
        created.push({ ticker, strike, market: market.toBase58() });
      } catch (err) {
        if (isAlreadyInitialized(err)) {
          console.log(
            `[bootstrap-devnet]   ${ticker} @ $${(strike / 100).toFixed(2)} already exists (race), continuing`,
          );
          created.push({ ticker, strike, market: market.toBase58() });
        } else {
          console.error(
            `[bootstrap-devnet]   FAILED ${ticker} @ ${strike}: ${errMsg(err)}`,
          );
        }
      }
    }
  }

  // ------------------------------------------------------------------------
  // Step 4: summary
  // ------------------------------------------------------------------------
  console.log("");
  console.log("============================================================");
  console.log("  Meridian DEVNET bootstrap complete");
  console.log("============================================================");
  console.log(`  Program ID : ${programId.toBase58()}`);
  console.log(`  USDC mint  : ${usdcMint.toBase58()}`);
  console.log(`  Admin      : ${admin.publicKey.toBase58()}`);
  console.log(`  Dev wallet : ${devWallet.publicKey.toBase58()}`);
  console.log(
    `              -> get USDC at https://spl-token-faucet.com/?token-name=USDC-Dev`,
  );
  console.log(`  Markets    : ${created.length}`);
  for (const ticker of MAG7_TICKERS) {
    const forTicker = created.filter((m) => m.ticker === ticker);
    const strikes = forTicker
      .map((m) => `$${(m.strike / 100).toFixed(0)}`)
      .join(", ");
    console.log(
      `    ${ticker.padEnd(6)} ${forTicker.length} strikes (${priceSource[ticker]} price): ${strikes}`,
    );
  }
  console.log("============================================================");
}

main().catch((err) => {
  console.error("[bootstrap-devnet] FATAL:", errMsg(err));
  process.exit(1);
});
