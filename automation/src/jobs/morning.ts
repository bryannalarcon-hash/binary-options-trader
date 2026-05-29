import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { isNyseTradingDay } from "../calendar";
import { env } from "../env";
import { sendAlert } from "../lib/alerts";
import { buildAnchorContext, getAnchorContext, isProgramDeployed } from "../lib/anchor";
import { todayExpiryTsSeconds } from "../lib/expiry";
import { fetchMag7Prices } from "../lib/hermes";
import { oraclePriceToUsd, resolvePreviousCloseUsd } from "../lib/morning-price";
import {
  configPda,
  marketPda,
  noMintPda,
  oraclePda,
  orderbookPda,
  yesMintPda,
} from "../lib/pdas";
import { retry } from "../lib/retry";
import { seedMarketBook } from "../lib/seed";
import { computeStrikes } from "../lib/strikes";
import { MAG7_TICKERS } from "../lib/tickers";
import { sendHttp } from "../lib/tx";
import { ctx } from "../logger";

/** MM book seeding defaults (size = tokens per side, spread = bid/ask gap in ¢). */
const SEED_SIZE = 100;
const SEED_SPREAD_CENTS = 6;

const log = ctx("morning");

// Local PDA helpers for the bid/ask escrows (not in pdas.ts yet).
const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");
function usdcEscrowPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USDC_ESCROW_SEED, market.toBuffer()],
    programId,
  );
}
function yesEscrowPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YES_ESCROW_SEED, market.toBuffer()],
    programId,
  );
}

export interface MorningResult {
  ticker: string;
  previousCloseCents: number | null;
  priceSource: "hermes" | "oracle" | "none";
  strikesAttempted: number[];
  strikesCreated: number[];
  strikesSeeded: number[];
  marketPubkeys: string[];
  errors: Array<{ strike: number; reason: string }>;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Morning job (~8:00 AM ET).
 *
 * For each MAG7 ticker:
 *   1. Resolve previous close: prefer Pyth Hermes, fall back to the on-chain
 *      oracle when Hermes is unavailable (so a Hermes outage can't silently
 *      create zero markets — the 2026-05-28/29 failure).
 *   2. Compute strike grid (±3/6/9%, $10 rounded, dedup).
 *   3. For each missing strike, create `create_strike_market` + `init_market_books`
 *      then seed a two-sided MM book — so markets are never an empty `0/100`.
 *
 * Idempotent — markets that already exist for today's expiry are skipped (both
 * create and seed), so a re-run never double-seeds. Uses the ADMIN keypair: it
 * holds the USDC needed to seed and is already loaded for the oracle job. All
 * writes confirm via HTTP polling ({@link sendHttp}) to dodge the throttled WS
 * confirmation path.
 *
 * Health: if the run ends with ZERO markets for today's expiry, it THROWS so
 * the job is recorded as failed (not a silent "ok") and an alert fires.
 */
export async function runMorningJob(): Promise<MorningResult[]> {
  if (!env.skipCalendarCheck && !isNyseTradingDay()) {
    log.info("not a trading day — skipping");
    return [];
  }

  let anchor;
  try {
    // Admin context: holds USDC for seeding + is already used by the oracle job.
    anchor = getAnchorContext(env.adminKeypairPath);
  } catch (err) {
    log.warn(
      { err: errMsg(err) },
      "anchor context unavailable — contract likely not deployed yet",
    );
    await sendAlert({
      severity: "warning",
      source: "morning",
      message: "anchor context unavailable",
      details: { error: errMsg(err) },
    });
    return [];
  }

  if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
    log.warn(
      { programId: anchor.programId.toBase58() },
      "program not deployed at expected ID — skipping",
    );
    return [];
  }

  // Previous close: Hermes first (freshest "16h-ago close"), oracle as fallback.
  const priceMap = await fetchMag7Prices(env.pythFeeds).catch((err) => {
    log.warn({ err: errMsg(err) }, "hermes fetch failed — will fall back to on-chain oracle");
    return new Map();
  });

  const expiryTs = todayExpiryTsSeconds();
  log.info(
    { expiryTs, expiryIso: new Date(expiryTs * 1000).toISOString() },
    "computed expiry timestamp",
  );

  // Fee destination (place_order routes the taker fee here) + the set of markets
  // that already exist for today's expiry, so we skip create+seed for those.
  const [configPk] = configPda(anchor.programId);
  const cfg: any = await (anchor.program.account as any).config.fetch(configPk);
  const feeDestination: PublicKey = cfg.feeDestination;

  const existing = new Set<string>();
  try {
    const all: Array<{ account: any }> = await (anchor.program.account as any).market.all();
    for (const m of all) {
      if (Number(m.account.expiryTs) === expiryTs) {
        existing.add(`${m.account.ticker}:${Number(m.account.strike)}`);
      }
    }
  } catch (err) {
    log.warn({ err: errMsg(err) }, "could not prefetch existing markets — proceeding (creates may no-op)");
  }

  const results: MorningResult[] = [];
  for (const ticker of MAG7_TICKERS) {
    const hermesUsd = priceMap.get(ticker)?.priceUsd ?? null;
    const oracleUsd = await readOracleUsd(anchor, ticker);
    const previousClose = resolvePreviousCloseUsd(hermesUsd, oracleUsd);
    const priceSource: MorningResult["priceSource"] =
      hermesUsd != null && previousClose === hermesUsd
        ? "hermes"
        : previousClose != null
          ? "oracle"
          : "none";

    const result = await runMorningForTicker(
      anchor,
      ticker,
      previousClose,
      priceSource,
      expiryTs,
      existing,
      feeDestination,
    );
    results.push(result);
    log.info(
      {
        ticker: result.ticker,
        price_source: result.priceSource,
        strikes_attempted: result.strikesAttempted,
        strikes_created: result.strikesCreated,
        strikes_seeded: result.strikesSeeded,
        market_pubkeys: result.marketPubkeys,
        errors: result.errors,
      },
      "morning ticker done",
    );
  }

  // Honest health: a run that leaves ZERO markets for today's expiry is a
  // failure, not a silent success (the 2026-05-28/29 Hermes-outage bug).
  const created = results.reduce((n, r) => n + r.strikesCreated.length, 0);
  const totalMarkets = existing.size + created;
  if (totalMarkets === 0) {
    await sendAlert({
      severity: "error",
      source: "morning",
      message: "morning run produced ZERO markets for today's expiry",
      details: { expiryTs, tickers: MAG7_TICKERS.length },
    });
    throw new Error("morning job created/found 0 markets — no price source available for any ticker");
  }

  return results;
}

/** Read the on-chain oracle price (USD) for a ticker, or null if unavailable. */
async function readOracleUsd(
  anchor: ReturnType<typeof buildAnchorContext>,
  ticker: string,
): Promise<number | null> {
  try {
    const [oracle] = oraclePda(anchor.programId, ticker);
    const acc: any = await (anchor.program.account as any).oracleAccount.fetch(oracle);
    return oraclePriceToUsd(Number(acc.price), Number(acc.expo));
  } catch {
    return null;
  }
}

async function runMorningForTicker(
  anchor: ReturnType<typeof buildAnchorContext>,
  ticker: string,
  previousClose: number | null,
  priceSource: MorningResult["priceSource"],
  expiryTs: number,
  existing: Set<string>,
  feeDestination: PublicKey,
): Promise<MorningResult> {
  if (previousClose === null || previousClose <= 0) {
    return {
      ticker,
      previousCloseCents: null,
      priceSource: "none",
      strikesAttempted: [],
      strikesCreated: [],
      strikesSeeded: [],
      marketPubkeys: [],
      errors: [],
      skipped: true,
      skipReason: "no previous close available (Hermes + oracle both unavailable)",
    };
  }

  const previousCloseCents = Math.round(previousClose * 100);
  const strikes = computeStrikes(previousCloseCents);

  const result: MorningResult = {
    ticker,
    previousCloseCents,
    priceSource,
    strikesAttempted: strikes,
    strikesCreated: [],
    strikesSeeded: [],
    marketPubkeys: [],
    errors: [],
    skipped: false,
  };

  const { program, programId, connection } = anchor;
  const payer: Keypair = (anchor.wallet as any).payer;
  const [config] = configPda(programId);
  const usdcMint = usdcMintPubkey();
  const spotUsd = previousClose;

  for (const strike of strikes) {
    const [market] = marketPda(programId, ticker, strike, expiryTs);
    const [yesMint] = yesMintPda(programId, market);
    const [noMint] = noMintPda(programId, market);

    // Idempotent: a market that already exists for this expiry was created AND
    // seeded in a prior run — skip both to avoid double-seeding the book.
    if (existing.has(`${ticker}:${strike}`)) {
      result.marketPubkeys.push(market.toBase58());
      continue;
    }

    const [oracle] = oraclePda(programId, ticker);
    const [orderbook] = orderbookPda(programId, market);
    const [usdcEscrow] = usdcEscrowPda(programId, market);
    const [yesEscrow] = yesEscrowPda(programId, market);
    const vault = getAssociatedTokenAddressSync(usdcMint, market, true);

    // 1. Create market + init books (one tx), confirmed via HTTP polling.
    try {
      await retry(
        async () => {
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
              payer: payer.publicKey,
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
              payer: payer.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction();
          await sendHttp(connection, payer, [createIx, initIx]);
        },
        {
          attempts: 3,
          initialDelayMs: 1000,
          backoffFactor: 2,
          shouldRetry: (err) => !isAlreadyExistsError(err),
          onRetry: (err, attempt, wait) =>
            log.warn(
              { ticker, strike, attempt, wait, err: errMsg(err) },
              "create_strike_market+init retry",
            ),
        },
      );
      result.strikesCreated.push(strike);
      result.marketPubkeys.push(market.toBase58());
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        log.info({ ticker, strike, market: market.toBase58() }, "market already exists — skipping create");
        result.marketPubkeys.push(market.toBase58());
        continue; // already existed (and presumably seeded) — don't re-seed
      }
      result.errors.push({ strike, reason: errMsg(err) });
      log.error({ ticker, strike, err: errMsg(err) }, "create_strike_market failed after retries");
      await sendAlert({
        severity: "error",
        source: "morning",
        message: `create_strike_market failed for ${ticker} @ ${strike}`,
        details: { ticker, strike, error: errMsg(err) },
      });
      continue; // can't seed a market that wasn't created
    }

    // 2. Seed a two-sided MM book — best-effort: a seed failure must NOT undo a
    // successfully created market (it just shows an estimated price until seeded).
    try {
      const { bid, ask } = await seedMarketBook({
        program,
        connection,
        payer,
        programId,
        market,
        yesMint,
        noMint,
        usdcMint,
        feeDestination,
        spotUsd,
        strikeCents: strike,
        size: SEED_SIZE,
        spreadCents: SEED_SPREAD_CENTS,
      });
      result.strikesSeeded.push(strike);
      log.info({ ticker, strike, bid, ask }, "seeded MM book");
    } catch (err) {
      log.warn({ ticker, strike, err: errMsg(err) }, "MM seed failed (market created, left unseeded)");
    }
  }

  return result;
}

/**
 * Look up the USDC mint pubkey. Lazy so we don't crash at module-load if the
 * env var isn't set — the morning job already returns early in that case.
 */
function usdcMintPubkey(): PublicKey {
  if (!env.usdcMint) throw new Error("USDC_MINT not set in env");
  return new PublicKey(env.usdcMint);
}

/** Anchor / SVM patterns for "this account is already initialized". */
function isAlreadyExistsError(err: unknown): boolean {
  const m = errMsg(err).toLowerCase();
  return (
    m.includes("already in use") ||
    m.includes("custom program error: 0x0") ||
    m.includes("accountalreadyinuse")
  );
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

// -----------------------------------------------------------------------------
// CLI entrypoint: `pnpm --filter automation morning`
// -----------------------------------------------------------------------------
if (require.main === module) {
  runMorningJob()
    .then((results) => {
      log.info({ count: results.length }, "morning job finished");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err: errMsg(err) }, "morning job crashed");
      process.exit(1);
    });
}
