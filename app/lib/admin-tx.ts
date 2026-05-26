/**
 * Admin / dev-panel transaction builders + reads.
 *
 * These mirror the wiring used by `automation/src/jobs/*` and
 * `scripts/bootstrap-devnet.ts`, but run client-side via the connected
 * wallet (`useWallet()`). Every read + write is REAL on-chain — there are
 * no mocks here. When the connected wallet is not the configured admin /
 * oracle authority the contract simply reverts and the caller surfaces the
 * error toast.
 *
 * Functions exposed:
 *   - readConfig                — Config PDA (admin / oracle_authority / paused)
 *   - readOracle                — OracleAccount PDA for one ticker
 *   - readAllOracles            — OracleAccount PDA for every MAG7 ticker
 *   - pushOraclePrice           — update_oracle(ticker, priceCents, …)
 *   - fetchHermesMag7           — live Hermes prices for the MAG7 set (client)
 *   - settleMarket              — settle_market() for one market
 *   - adminSettleOverride       — admin_settle_override(manualPrice)
 *   - pause                     — pause(paused)
 *   - createTodaysMarketsForTicker — create_strike_market + init_market_books
 *
 * Convention reminders (match the Rust contract):
 *   - All on-chain prices are integer USD CENTS.
 *   - `update_oracle` stores cents, so we always pass `expo = -2`.
 *   - Strike grid is ±3/6/9% off previous close, $10 ($1000 cents) rounded.
 *   - Markets expire at 4:00 PM America/New_York (NYSE close).
 */

import {
  BN,
  AnchorProvider,
  Program,
  type Idl,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

import { env } from "./env";
import idl from "./meridian-idl.json";
import { MAG7_TICKERS, PYTH_FEED_ID, type Ticker } from "./tickers";

// ---------------------------------------------------------------------------
// PDA seeds (lockstep with programs/meridian/src/pdas.rs + composite-tx.ts)
// ---------------------------------------------------------------------------

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
  return new BN(value.toString()).toTwos(64).toArrayLike(Buffer, "le", 8);
}

function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}
function oraclePda(programId: PublicKey, ticker: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ORACLE_SEED, Buffer.from(ticker, "utf8")],
    programId,
  )[0];
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

// ---------------------------------------------------------------------------
// Program builders
// ---------------------------------------------------------------------------

/** Build a read-only `Program` from the bundled IDL (no signing wallet). */
function buildReadProgram(
  connection: Connection,
): { program: Program; programId: PublicKey } | null {
  if (!env.programId) return null;
  let programId: PublicKey;
  try {
    programId = new PublicKey(env.programId);
  } catch {
    return null;
  }
  // Minimal wallet shim — never used for signing on the read path.
  const dummy = PublicKey.default;
  const dummyWallet = {
    publicKey: dummy,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet as any, {
    commitment: "confirmed",
  });
  const idlAny = idl as Idl & { address?: string };
  idlAny.address = programId.toBase58();
  return { program: new Program(idlAny, provider), programId };
}

/** Build a signing `Program` from the connected wallet. */
function buildWriteProgram(
  connection: Connection,
  wallet: WalletContextState,
): { program: Program; programId: PublicKey; provider: AnchorProvider } | null {
  if (!env.programId) return null;
  if (!wallet.connected || !wallet.publicKey) {
    throw new Error("Wallet not connected");
  }
  const programId = new PublicKey(env.programId);
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idlAny = idl as Idl & { address?: string };
  idlAny.address = programId.toBase58();
  return { program: new Program(idlAny, provider), programId, provider };
}

function bnToNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as BN).toString === "function") return Number((v as BN).toString());
  return Number(v);
}

// ---------------------------------------------------------------------------
// Config + oracle reads
// ---------------------------------------------------------------------------

export interface ConfigState {
  admin: string;
  feeDestination: string;
  oracleAuthority: string;
  usdcMint: string;
  paused: boolean;
}

/** Read the on-chain Config PDA. Returns null if not deployed / not found. */
export async function readConfig(
  connection: Connection,
): Promise<ConfigState | null> {
  const built = buildReadProgram(connection);
  if (!built) return null;
  try {
    const acct = (await (built.program.account as any).config.fetch(
      configPda(built.programId),
    )) as {
      admin: PublicKey;
      feeDestination: PublicKey;
      oracleAuthority: PublicKey;
      usdcMint: PublicKey;
      paused: boolean;
    };
    return {
      admin: acct.admin.toBase58(),
      feeDestination: acct.feeDestination.toBase58(),
      oracleAuthority: acct.oracleAuthority.toBase58(),
      usdcMint: acct.usdcMint.toBase58(),
      paused: !!acct.paused,
    };
  } catch {
    return null;
  }
}

export interface OracleState {
  ticker: Ticker;
  /** On-chain price in cents (since expo = -2). */
  priceCents: number;
  /** Confidence in cents. */
  confCents: number;
  /** Unix seconds of last publish. */
  publishTime: number;
  expo: number;
  /** Seconds since publish (computed against `Date.now()`). */
  stalenessSec: number;
  exists: boolean;
}

/** Read one ticker's OracleAccount PDA. `exists: false` when uninitialized. */
export async function readOracle(
  connection: Connection,
  ticker: Ticker,
): Promise<OracleState> {
  const built = buildReadProgram(connection);
  const nowSec = Math.floor(Date.now() / 1000);
  const empty: OracleState = {
    ticker,
    priceCents: 0,
    confCents: 0,
    publishTime: 0,
    expo: -2,
    stalenessSec: 0,
    exists: false,
  };
  if (!built) return empty;
  try {
    const acct = (await (built.program.account as any).oracleAccount.fetch(
      oraclePda(built.programId, ticker),
    )) as { price: BN; conf: BN; publishTime: BN; expo: number };
    const publishTime = bnToNumber(acct.publishTime);
    return {
      ticker,
      priceCents: bnToNumber(acct.price),
      confCents: bnToNumber(acct.conf),
      publishTime,
      expo: acct.expo,
      stalenessSec: Math.max(0, nowSec - publishTime),
      exists: true,
    };
  } catch {
    return empty;
  }
}

/** Read OracleAccount PDAs for all MAG7 tickers in parallel. */
export async function readAllOracles(
  connection: Connection,
): Promise<OracleState[]> {
  return Promise.all(MAG7_TICKERS.map((t) => readOracle(connection, t)));
}

// ---------------------------------------------------------------------------
// Oracle control — update_oracle
// ---------------------------------------------------------------------------

export interface PushOracleArgs {
  ticker: Ticker;
  /** New price in cents (e.g. 22050 = $220.50). */
  priceCents: number;
  /** Confidence in cents (small for the demo). */
  confCents?: number;
  /** Publish time (unix seconds). Defaults to now. */
  publishTime?: number;
}

/**
 * Push a price to the OracleAccount via `update_oracle`. Mirrors
 * `automation/src/jobs/update-oracle.ts#postOracleUpdate`. The connected
 * wallet must equal `config.oracle_authority` (= admin for v1) or the tx
 * reverts with `InvalidOracleAuthority` (6020).
 */
export async function pushOraclePrice(
  connection: Connection,
  wallet: WalletContextState,
  args: PushOracleArgs,
): Promise<string> {
  const built = buildWriteProgram(connection, wallet);
  if (!built) throw new Error("Program not configured (NEXT_PUBLIC_MERIDIAN_PROGRAM_ID)");
  const { program, programId } = built;

  const priceCents = Math.round(args.priceCents);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    throw new Error("Price must be a positive number of cents");
  }
  const confCents = Math.max(1, Math.round(args.confCents ?? 1));
  const publishTime = args.publishTime ?? Math.floor(Date.now() / 1000);

  return (program.methods as any)
    .updateOracle(
      args.ticker,
      new BN(priceCents),
      new BN(confCents),
      new BN(publishTime),
      -2, // cents convention — fixed exponent
    )
    .accounts({
      config: configPda(programId),
      oracle: oraclePda(programId, args.ticker),
      oracleAuthority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

// ---------------------------------------------------------------------------
// Live Hermes prices (client-side) — mirrors automation/src/lib/hermes.ts
// ---------------------------------------------------------------------------

export interface HermesMag7Price {
  ticker: Ticker;
  priceUsd: number;
  confUsd: number;
  publishTime: number;
}

const HERMES_URL = "https://hermes.pyth.network";

/**
 * Fetch the latest Hermes prices for the MAG7 set in one round-trip.
 * Returns a map keyed by ticker. Mirrors `fetchMag7Prices` but runs in the
 * browser (no `@meridian/env`); feed IDs come from `PYTH_FEED_ID`.
 */
export async function fetchHermesMag7(): Promise<Map<Ticker, HermesMag7Price>> {
  const entries = MAG7_TICKERS.map((t) => [t, PYTH_FEED_ID[t]] as const).filter(
    ([, id]) => !!id,
  );
  const params = entries
    .map(([, id]) => `ids[]=${encodeURIComponent(id)}`)
    .join("&");
  const url = `${HERMES_URL}/v2/updates/price/latest?${params}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Hermes returned ${res.status}`);
  }
  const body = (await res.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };

  // Index returned prices by normalized (no-0x) feed id.
  const byId = new Map<
    string,
    { priceUsd: number; confUsd: number; publishTime: number }
  >();
  for (const entry of body.parsed ?? []) {
    const norm = entry.id.startsWith("0x") ? entry.id.slice(2) : entry.id;
    const { price, conf, expo, publish_time } = entry.price;
    const scale = Math.pow(10, expo);
    byId.set(norm.toLowerCase(), {
      priceUsd: Number(price) * scale,
      confUsd: Number(conf) * scale,
      publishTime: publish_time,
    });
  }

  const out = new Map<Ticker, HermesMag7Price>();
  for (const [ticker, id] of entries) {
    const norm = (id.startsWith("0x") ? id.slice(2) : id).toLowerCase();
    const got = byId.get(norm);
    if (got) {
      out.set(ticker, {
        ticker,
        priceUsd: got.priceUsd,
        confUsd: got.confUsd,
        publishTime: got.publishTime,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settlement — settle_market / admin_settle_override
// ---------------------------------------------------------------------------

/**
 * Settle one market via `settle_market()`. The market PDA + its oracle are
 * read off the on-chain Market account (passed in by the caller). Reverts
 * with `OraclesStale` (6006) / `OracleConfidenceWide` (6007) if the oracle
 * isn't fresh — push a price first.
 */
export async function settleMarket(
  connection: Connection,
  wallet: WalletContextState,
  marketAddress: string,
  oracleAddress: string,
): Promise<string> {
  const built = buildWriteProgram(connection, wallet);
  if (!built) throw new Error("Program not configured");
  const { program, programId } = built;
  return (program.methods as any)
    .settleMarket()
    .accounts({
      market: new PublicKey(marketAddress),
      oracle: new PublicKey(oracleAddress),
      config: configPda(programId),
      caller: wallet.publicKey,
    })
    .rpc();
}

/**
 * Admin fallback: `admin_settle_override(manual_price)`. Requires
 * `now >= expiry + 3600` and the admin signer, else reverts with
 * `TimeGateNotElapsed` (6009) / `AdminRequired` (6008).
 */
export async function adminSettleOverride(
  connection: Connection,
  wallet: WalletContextState,
  marketAddress: string,
  manualPriceCents: number,
): Promise<string> {
  const built = buildWriteProgram(connection, wallet);
  if (!built) throw new Error("Program not configured");
  const { program, programId } = built;
  return (program.methods as any)
    .adminSettleOverride(new BN(Math.round(manualPriceCents)))
    .accounts({
      config: configPda(programId),
      market: new PublicKey(marketAddress),
      admin: wallet.publicKey,
    })
    .rpc();
}

// ---------------------------------------------------------------------------
// Pause / unpause
// ---------------------------------------------------------------------------

/** Toggle the global pause flag via `pause(paused)`. Admin-only. */
export async function setPaused(
  connection: Connection,
  wallet: WalletContextState,
  paused: boolean,
): Promise<string> {
  const built = buildWriteProgram(connection, wallet);
  if (!built) throw new Error("Program not configured");
  const { program, programId } = built;
  return (program.methods as any)
    .pause(paused)
    .accounts({
      config: configPda(programId),
      admin: wallet.publicKey,
    })
    .rpc();
}

// ---------------------------------------------------------------------------
// Market creation — create_strike_market + init_market_books
// ---------------------------------------------------------------------------

/** ±3/6/9% strike grid, $10 ($1000 cents) rounded, dedup + sorted. */
const STRIKE_PERCENTAGES = [-9, -6, -3, 3, 6, 9] as const;
const STRIKE_STEP_CENTS = 1000;

function roundToStep(valueCents: number, step: number): number {
  const sign = valueCents >= 0 ? 1 : -1;
  const abs = Math.abs(valueCents);
  return sign * Math.round(abs / step) * step;
}

/** Mirror of `automation/src/lib/strikes.ts#computeStrikes`. */
export function computeStrikes(previousCloseCents: number): number[] {
  if (!Number.isFinite(previousCloseCents) || previousCloseCents <= 0) {
    throw new Error(`computeStrikes: invalid previous close ${previousCloseCents}`);
  }
  const strikes = new Set<number>();
  for (const pct of STRIKE_PERCENTAGES) {
    const raw = previousCloseCents * (1 + pct / 100);
    const rounded = roundToStep(raw, STRIKE_STEP_CENTS);
    if (rounded > 0) strikes.add(rounded);
  }
  return Array.from(strikes).sort((a, b) => a - b);
}

/**
 * Today's 4:00 PM America/New_York expiry as unix seconds.
 * Mirror of `automation/src/lib/expiry.ts#todayExpiryTsSeconds`.
 */
export function todayExpiryTsSeconds(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(now)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    map.year ?? year,
    (map.month ?? month) - 1,
    map.day ?? day,
    map.hour === 24 ? 0 : map.hour ?? 0,
    map.minute ?? 0,
    map.second ?? 0,
  );
  const offsetMinutes = Math.round((asUtc - now.getTime()) / 60_000);
  const target = Date.UTC(year, month - 1, day, 16, 0, 0);
  return Math.floor((target - offsetMinutes * 60_000) / 1000);
}

export interface CreateStrikeResult {
  strike: number;
  status: "created" | "skipped" | "failed";
  market: string;
  reason?: string;
}

export interface CreateMarketsResult {
  ticker: Ticker;
  previousCloseCents: number;
  expiryTs: number;
  strikes: CreateStrikeResult[];
}

/** Anchor "account already initialized" detector (idempotent skip). */
function isAlreadyExistsError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes("already in use") ||
    m.includes("custom program error: 0x0") ||
    m.includes("accountalreadyinuse")
  );
}

/**
 * Create today's markets for one ticker. Computes the ±3/6/9% strike grid off
 * `previousCloseCents`, then for each strike bundles `create_strike_market` +
 * `init_market_books` into a single tx (the contract requires the pair). Skips
 * strikes whose market PDA already exists (idempotent). Mirrors
 * `automation/src/jobs/morning.ts`.
 *
 * @param existingStrikes  strikes already on-chain for this (ticker, today's
 *                         expiry) — used to skip without a failed tx.
 */
export async function createTodaysMarketsForTicker(
  connection: Connection,
  wallet: WalletContextState,
  ticker: Ticker,
  previousCloseCents: number,
  existingStrikes: number[] = [],
): Promise<CreateMarketsResult> {
  const built = buildWriteProgram(connection, wallet);
  if (!built) throw new Error("Program not configured");
  if (!env.usdcMint) throw new Error("USDC mint not configured");
  const { program, programId, provider } = built;

  const usdcMint = new PublicKey(env.usdcMint);
  const config = configPda(programId);
  const expiryTs = todayExpiryTsSeconds();
  const strikes = computeStrikes(previousCloseCents);
  const existing = new Set(existingStrikes);

  const results: CreateStrikeResult[] = [];

  for (const strike of strikes) {
    const market = marketPda(programId, ticker, strike, expiryTs);
    if (existing.has(strike)) {
      results.push({ strike, status: "skipped", market: market.toBase58() });
      continue;
    }
    const yesMint = yesMintPda(programId, market);
    const noMint = noMintPda(programId, market);
    const oracle = oraclePda(programId, ticker);
    const orderbook = orderbookPda(programId, market);
    const usdcEscrow = usdcEscrowPda(programId, market);
    const yesEscrow = yesEscrowPda(programId, market);
    const vault = getAssociatedTokenAddressSync(usdcMint, market, true);

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
          payer: wallet.publicKey,
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
          payer: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const tx = new Transaction().add(createIx, initIx);
      await provider.sendAndConfirm(tx);
      results.push({ strike, status: "created", market: market.toBase58() });
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        results.push({ strike, status: "skipped", market: market.toBase58() });
      } else {
        results.push({
          strike,
          status: "failed",
          market: market.toBase58(),
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { ticker, previousCloseCents, expiryTs, strikes: results };
}

export { configPda, oraclePda, marketPda };
