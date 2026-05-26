import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { isNyseTradingDay } from "../calendar";
import { env } from "../env";
import { sendAlert } from "../lib/alerts";
import { buildAnchorContext, getAnchorContext, isProgramDeployed } from "../lib/anchor";
import { todayExpiryTsSeconds } from "../lib/expiry";
import { fetchMag7Prices } from "../lib/hermes";
import {
  configPda,
  marketPda,
  noMintPda,
  oraclePda,
  orderbookPda,
  yesMintPda,
} from "../lib/pdas";
import { retry } from "../lib/retry";
import { computeStrikes } from "../lib/strikes";
import { MAG7_TICKERS } from "../lib/tickers";
import { ctx } from "../logger";

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
  strikesAttempted: number[];
  strikesCreated: number[];
  marketPubkeys: string[];
  errors: Array<{ strike: number; reason: string }>;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Morning job (~8:00 AM ET).
 *
 * For each MAG7 ticker:
 *   1. Read previous close (Hermes for now — TODO: read oracle PDA on-chain).
 *   2. Compute strike grid (±3/6/9%, $10 rounded, dedup).
 *   3. For each strike, bundle `create_strike_market` + `init_market_books`
 *      into a single transaction (the smart contract requires them paired
 *      because `init_market_books` initializes the orderbook + bid/ask
 *      escrows that the rest of the contract assumes to exist).
 *
 * Idempotent — if the market PDA already exists the Anchor `init` constraint
 * fails with "already in use" / 0x0 and we log + skip.
 */
export async function runMorningJob(): Promise<MorningResult[]> {
  if (!env.skipCalendarCheck && !isNyseTradingDay()) {
    log.info("not a trading day — skipping");
    return [];
  }

  let anchor;
  try {
    anchor = getAnchorContext(env.automationKeypairPath);
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

  // Fetch previous closes off-chain for now. The on-chain oracle account holds
  // the latest pushed price; we could also read that — but Hermes is the source
  // of truth for "what was the close 16 hours ago" before settlement runs.
  const priceMap = await fetchMag7Prices(env.pythFeeds).catch((err) => {
    log.warn({ err: errMsg(err) }, "hermes fetch failed");
    return new Map();
  });

  const expiryTs = todayExpiryTsSeconds();
  log.info(
    { expiryTs, expiryIso: new Date(expiryTs * 1000).toISOString() },
    "computed expiry timestamp",
  );

  const results: MorningResult[] = [];
  for (const ticker of MAG7_TICKERS) {
    const result = await runMorningForTicker(
      anchor,
      ticker,
      priceMap.get(ticker)?.priceUsd ?? null,
      expiryTs,
    );
    results.push(result);
    log.info(
      {
        ticker: result.ticker,
        strikes_attempted: result.strikesAttempted,
        strikes_created: result.strikesCreated,
        market_pubkeys: result.marketPubkeys,
        errors: result.errors,
      },
      "morning ticker done",
    );
  }

  return results;
}

async function runMorningForTicker(
  anchor: ReturnType<typeof buildAnchorContext>,
  ticker: string,
  previousClose: number | null,
  expiryTs: number,
): Promise<MorningResult> {
  if (previousClose === null || previousClose <= 0) {
    return {
      ticker,
      previousCloseCents: null,
      strikesAttempted: [],
      strikesCreated: [],
      marketPubkeys: [],
      errors: [],
      skipped: true,
      skipReason: "no previous close available",
    };
  }

  const previousCloseCents = Math.round(previousClose * 100);
  const strikes = computeStrikes(previousCloseCents);

  const result: MorningResult = {
    ticker,
    previousCloseCents,
    strikesAttempted: strikes,
    strikesCreated: [],
    marketPubkeys: [],
    errors: [],
    skipped: false,
  };

  const { program, programId, provider, wallet } = anchor;
  const [config] = configPda(programId);
  const usdcMint = usdcMintPubkey();

  for (const strike of strikes) {
    const [market] = marketPda(programId, ticker, strike, expiryTs);
    const [yesMint] = yesMintPda(programId, market);
    const [noMint] = noMintPda(programId, market);
    const [oracle] = oraclePda(programId, ticker);
    const [orderbook] = orderbookPda(programId, market);
    const [usdcEscrow] = usdcEscrowPda(programId, market);
    const [yesEscrow] = yesEscrowPda(programId, market);

    // Vault is the ATA of usdc_mint owned by the market PDA (off-curve).
    const vault = getAssociatedTokenAddressSync(usdcMint, market, true);

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
        log.info(
          { ticker, strike, market: market.toBase58() },
          "market already exists — skipping (idempotent)",
        );
        result.marketPubkeys.push(market.toBase58());
      } else {
        result.errors.push({ strike, reason: errMsg(err) });
        log.error(
          { ticker, strike, err: errMsg(err) },
          "create_strike_market failed after retries",
        );
        await sendAlert({
          severity: "error",
          source: "morning",
          message: `create_strike_market failed for ${ticker} @ ${strike}`,
          details: { ticker, strike, error: errMsg(err) },
        });
      }
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
