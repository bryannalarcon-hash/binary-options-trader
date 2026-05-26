#!/usr/bin/env tsx
/**
 * scripts/mm-sdk.ts — Reference market-making bot for Meridian.
 *
 * Per IMPLEMENTATION_PLAN §14.4 #6 [MAY]:
 *   "Market-making quoter SDK — a thin TypeScript module wrapping Phoenix
 *    order placement, exposing quoteBothSides(market, midPrice, spread, size).
 *    Example script showing a basic delta-flat quoting strategy. Demonstrates
 *    platform usability for actual market-making firms — like Peak6."
 *
 * What this does:
 *   1. Connects to the program via Anchor (signer: MM_KEYPAIR_PATH or
 *      ADMIN_KEYPAIR_PATH fallback).
 *   2. Resolves a specific market by (ticker, strike, expiry) — strike in
 *      cents, expiry defaults to today's 8 PM UTC.
 *   3. Optionally mints N pairs from USDC inventory (so the bot has inventory
 *      to quote BOTH sides — Yes asks and No asks, which is the delta-flat
 *      stance described in IMPLEMENTATION_PLAN §14.4 #4).
 *   4. Loops every 30s:
 *      a. Reads the order book.
 *      b. Computes mid = (best_bid + best_ask) / 2, or falls back to --mid
 *         (oracle anchor) if the book is one-sided.
 *      c. Cancels existing MM orders, posts new bid/ask at mid ± spread/2.
 *      d. Sleeps.
 *   5. SIGINT (Ctrl-C): cancel all open orders before exiting.
 *
 * Delta-hedge documentation (see also docs/MARKET_MAKING.md):
 *   A Meridian Yes token has delta ≈ 1 − 2·price near the strike — a $0.50 Yes
 *   has ~zero delta to underlying; a $0.10 Yes has ~+0.8 delta (long stock-
 *   like exposure). To delta-hedge a quoting book of `N` Yes contracts at
 *   price p with strike K on an underlying spot S:
 *
 *     delta_per_yes ≈ φ(d2) · 1 / (S · σ · √T)
 *
 *   where φ is the standard normal pdf, σ is daily vol, T is fraction of
 *   trading day remaining. For a portfolio with `n_yes` net Yes and `n_no`
 *   net No:
 *
 *     portfolio_delta = (n_yes - n_no) · delta_per_yes
 *
 *   To hedge, short |portfolio_delta · contract_size| shares of the
 *   underlying on a venue like Drift Protocol's MAG7 perpetuals or a CEX.
 *   Pseudocode:
 *
 *     const delta = computePortfolioDelta(book, S, sigma, T);
 *     const hedgeNotional = delta * contractSizeUsd;
 *     await drift.placePerp({
 *       market: `${ticker}-PERP`,
 *       side: delta > 0 ? "short" : "long",
 *       sizeUsd: Math.abs(hedgeNotional),
 *       orderType: "market",
 *     });
 *
 *   We don't ship a Drift integration here — Drift Protocol's MAG7 perp
 *   markets came out of multisig compromise in April 2026 and are still in
 *   recovery as of demo time. The script prints what it WOULD hedge in
 *   `--delta-hedge` mode so a real MM operator can wire it to their venue
 *   of choice.
 *
 * Usage examples (see also docs/MARKET_MAKING.md):
 *   # Basic quoter (no hedging), 30s loop, 4¢ spread, size 100:
 *   pnpm tsx scripts/mm-sdk.ts AAPL 22000 --mid 65 --spread 4 --size 100
 *
 *   # Single-shot quote then exit:
 *   pnpm tsx scripts/mm-sdk.ts AAPL 22000 --mid 50 --once
 *
 *   # With delta-hedge logging (computes hedge, prints what it would do):
 *   pnpm tsx scripts/mm-sdk.ts AAPL 22000 --mid 65 --spread 2 --size 100 \
 *     --delta-hedge --underlying-spot 220.5 --daily-vol 0.018
 *
 *   # Mint 10 pairs of inventory before quoting:
 *   pnpm tsx scripts/mm-sdk.ts AAPL 22000 --mid 65 --mint-pairs 10
 *
 * Env vars consulted (via automation/.env):
 *   SOLANA_RPC_URL, MERIDIAN_PROGRAM_ID, USDC_MINT,
 *   MM_KEYPAIR_PATH (preferred) | ADMIN_KEYPAIR_PATH | AUTOMATION_KEYPAIR_PATH
 */

import * as path from "path";
import * as dotenv from "dotenv";

import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { buildAnchorContext, isProgramDeployed } from "../automation/src/lib/anchor";
import { todayExpiryTsSeconds } from "../automation/src/lib/expiry";
import {
  configPda,
  marketPda,
  noMintPda,
  orderbookPda,
  yesMintPda,
} from "../automation/src/lib/pdas";

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------

interface Args {
  ticker: string;
  strikeCents: number;
  expiryTs: number;
  midCents: number | null;
  spreadCents: number;
  sizeContracts: number;
  loopSeconds: number;
  mintPairs: number;
  once: boolean;
  deltaHedge: boolean;
  underlyingSpot: number | null;
  dailyVol: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once" || a === "--delta-hedge") {
      flags[a.slice(2)] = "true";
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    throw new Error(
      "Usage: pnpm tsx scripts/mm-sdk.ts <TICKER> <STRIKE_CENTS> [--mid N] [--spread N] [--size N] [--mint-pairs N] [--once] [--delta-hedge --underlying-spot S --daily-vol σ]",
    );
  }
  const ticker = positional[0].toUpperCase();
  const strikeCents = Number(positional[1]);
  if (!Number.isInteger(strikeCents) || strikeCents <= 0) {
    throw new Error(`STRIKE_CENTS must be a positive integer; got ${positional[1]}`);
  }
  return {
    ticker,
    strikeCents,
    expiryTs: flags.expiry ? Number(flags.expiry) : todayExpiryTsSeconds(),
    midCents: flags.mid ? Number(flags.mid) : null,
    spreadCents: flags.spread ? Number(flags.spread) : 4,
    sizeContracts: flags.size ? Number(flags.size) : 100,
    loopSeconds: flags["loop-seconds"] ? Number(flags["loop-seconds"]) : 30,
    mintPairs: flags["mint-pairs"] ? Number(flags["mint-pairs"]) : 0,
    once: flags.once === "true",
    deltaHedge: flags["delta-hedge"] === "true",
    underlyingSpot: flags["underlying-spot"]
      ? Number(flags["underlying-spot"])
      : null,
    dailyVol: flags["daily-vol"] ? Number(flags["daily-vol"]) : 0.018,
  };
}

// -----------------------------------------------------------------------------
// MM keypair resolution
// -----------------------------------------------------------------------------

function pickKeypairPath(): string {
  const candidates = [
    process.env.MM_KEYPAIR_PATH,
    process.env.ADMIN_KEYPAIR_PATH,
    process.env.AUTOMATION_KEYPAIR_PATH,
  ].filter((v): v is string => !!v && v.trim() !== "");
  if (candidates.length === 0) {
    throw new Error(
      "No MM_KEYPAIR_PATH / ADMIN_KEYPAIR_PATH / AUTOMATION_KEYPAIR_PATH set in env",
    );
  }
  return candidates[0];
}

// -----------------------------------------------------------------------------
// Order book reading
// -----------------------------------------------------------------------------

interface BookSide {
  price: number; // cents (0-100)
  size: number;
  owner: PublicKey;
}

interface BookView {
  bids: BookSide[];
  asks: BookSide[];
  bestBid: BookSide | null;
  bestAsk: BookSide | null;
}

/**
 * Fetch + decode the orderbook PDA. Returns an empty book if anchor can't
 * decode (e.g. the IDL doesn't expose orderbook decoding).
 */
async function readBook(
  anchor: ReturnType<typeof buildAnchorContext>,
  market: PublicKey,
): Promise<BookView> {
  const [orderbook] = orderbookPda(anchor.programId, market);
  const acct = anchor.program.account as Record<string, unknown>;
  const ob = acct.orderBook as
    | { fetch: (k: PublicKey) => Promise<unknown> }
    | undefined;
  if (!ob || typeof ob.fetch !== "function") {
    return { bids: [], asks: [], bestBid: null, bestAsk: null };
  }
  let raw: any;
  try {
    raw = await ob.fetch(orderbook);
  } catch {
    return { bids: [], asks: [], bestBid: null, bestAsk: null };
  }
  const decodeSide = (arr: any[]): BookSide[] =>
    (arr || [])
      .map((o) => ({
        price: Number(o.price ?? 0),
        size: typeof o.size?.toNumber === "function" ? o.size.toNumber() : Number(o.size ?? 0),
        owner: o.owner as PublicKey,
      }))
      .filter((o) => o.size > 0);

  const bids = decodeSide(raw.bids).sort((a, b) => b.price - a.price);
  const asks = decodeSide(raw.asks).sort((a, b) => a.price - b.price);

  return {
    bids,
    asks,
    bestBid: bids[0] ?? null,
    bestAsk: asks[0] ?? null,
  };
}

// -----------------------------------------------------------------------------
// Quote math (the SDK surface this script is demoing)
// -----------------------------------------------------------------------------

/**
 * Compute paired quotes around `midCents` ± `spreadCents / 2`. Clamps to the
 * Meridian price domain [1, 99] cents (the contract requires 0 < price < 100
 * for limit orders).
 */
export function quoteBothSides(
  midCents: number,
  spreadCents: number,
  sizeContracts: number,
): { bid: { price: number; size: number }; ask: { price: number; size: number } } {
  const half = Math.floor(spreadCents / 2);
  const bidPrice = Math.max(1, Math.min(99, midCents - half));
  const askPrice = Math.max(1, Math.min(99, midCents + half));
  if (askPrice <= bidPrice) {
    throw new Error(
      `quote degenerate: bid=${bidPrice} ask=${askPrice} (spread too narrow given mid=${midCents})`,
    );
  }
  return {
    bid: { price: bidPrice, size: sizeContracts },
    ask: { price: askPrice, size: sizeContracts },
  };
}

/**
 * Delta of a binary call (Yes token) under log-normal dynamics:
 *
 *   delta = φ(d2) / (S · σ · √T)
 *
 * Returns 0 if any input is missing — caller decides what to do.
 */
export function binaryYesDelta(
  spot: number,
  strike: number,
  dailyVol: number,
  tradingDayFraction = 1.0,
): number {
  if (spot <= 0 || strike <= 0 || dailyVol <= 0 || tradingDayFraction <= 0) {
    return 0;
  }
  const sigma = dailyVol * Math.sqrt(tradingDayFraction);
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma) / sigma;
  const phi = Math.exp(-0.5 * d2 * d2) / Math.sqrt(2 * Math.PI);
  return phi / (spot * sigma);
}

// -----------------------------------------------------------------------------
// On-chain ops
// -----------------------------------------------------------------------------

async function mintPairsIfRequested(
  anchor: ReturnType<typeof buildAnchorContext>,
  market: PublicKey,
  yesMint: PublicKey,
  noMint: PublicKey,
  usdcMint: PublicKey,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  const [config] = configPda(anchor.programId);
  const user = anchor.wallet.publicKey;
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user, false);
  const userYes = getAssociatedTokenAddressSync(yesMint, user, false);
  const userNo = getAssociatedTokenAddressSync(noMint, user, false);
  const vault = getAssociatedTokenAddressSync(usdcMint, market, true);

  process.stderr.write(`[mm] minting ${amount} pairs from USDC inventory…\n`);
  await (anchor.program.methods as any)
    .mintPair(new BN(amount))
    .accounts({
      config,
      market,
      yesMint,
      noMint,
      usdcMint,
      vault,
      userUsdc,
      userYes,
      userNo,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  process.stderr.write(`[mm] minted ${amount} pairs\n`);
}

async function fetchFeeDestination(
  anchor: ReturnType<typeof buildAnchorContext>,
): Promise<PublicKey | null> {
  const [config] = configPda(anchor.programId);
  const acct = anchor.program.account as Record<string, unknown>;
  const cfg = acct.config as { fetch: (k: PublicKey) => Promise<any> } | undefined;
  if (!cfg || typeof cfg.fetch !== "function") return null;
  try {
    const data = await cfg.fetch(config);
    return data?.feeDestination as PublicKey | null;
  } catch {
    return null;
  }
}

async function placeOrderSafe(
  anchor: ReturnType<typeof buildAnchorContext>,
  args: {
    market: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    usdcMint: PublicKey;
    feeDestination: PublicKey;
    side: "bid" | "ask";
    price: number;
    size: number;
  },
): Promise<string | null> {
  // Note: place_order requires a counterparty pair in the IDL — typical
  // crank-style books take the resting side's owner. For the demo MM loop we
  // pass the bot's own ATAs as both user AND counterparty (legal when no
  // cross occurs at post-time); a production wire-up would discover the
  // top-of-book taker.
  const user = anchor.wallet.publicKey;
  const userUsdc = getAssociatedTokenAddressSync(args.usdcMint, user, false);
  const userYes = getAssociatedTokenAddressSync(args.yesMint, user, false);
  const userNo = getAssociatedTokenAddressSync(args.noMint, user, false);
  const feeDestinationUsdc = getAssociatedTokenAddressSync(
    args.usdcMint,
    args.feeDestination,
    true,
  );
  const [orderbook] = orderbookPda(anchor.programId, args.market);
  const [config] = configPda(anchor.programId);

  const usdcEscrow = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_escrow"), args.market.toBuffer()],
    anchor.programId,
  )[0];
  const yesEscrow = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_escrow"), args.market.toBuffer()],
    anchor.programId,
  )[0];

  const sideVariant =
    args.side === "bid" ? { bid: {} } : { ask: {} };

  try {
    const sig = await (anchor.program.methods as any)
      .placeOrder(sideVariant, args.price, new BN(args.size))
      .accounts({
        config,
        market: args.market,
        orderbook,
        yesMint: args.yesMint,
        noMint: args.noMint,
        usdcMint: args.usdcMint,
        userUsdc,
        userYes,
        userNo,
        counterpartyUsdc: userUsdc, // self in demo mode
        counterpartyYes: userYes, // self in demo mode
        usdcEscrow,
        yesEscrow,
        feeDestinationUsdc,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .rpc();
    return sig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mm] place_order(${args.side}) failed: ${msg}\n`);
    return null;
  }
}

async function cancelOwnOrders(
  anchor: ReturnType<typeof buildAnchorContext>,
  market: PublicKey,
  yesMint: PublicKey,
  usdcMint: PublicKey,
  book: BookView,
): Promise<number> {
  const user = anchor.wallet.publicKey.toBase58();
  const [orderbook] = orderbookPda(anchor.programId, market);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, anchor.wallet.publicKey, false);
  const userYes = getAssociatedTokenAddressSync(yesMint, anchor.wallet.publicKey, false);
  const usdcEscrow = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_escrow"), market.toBuffer()],
    anchor.programId,
  )[0];
  const yesEscrow = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_escrow"), market.toBuffer()],
    anchor.programId,
  )[0];

  const mine = [
    ...book.bids
      .map((b, i) => ({ order: b, side: "bid" as const, idx: i }))
      .filter((o) => o.order.owner.toBase58() === user),
    ...book.asks
      .map((a, i) => ({ order: a, side: "ask" as const, idx: i }))
      .filter((o) => o.order.owner.toBase58() === user),
  ];
  let cancelled = 0;
  for (const o of mine) {
    try {
      const sideVariant = o.side === "bid" ? { bid: {} } : { ask: {} };
      await (anchor.program.methods as any)
        .cancelOrder(sideVariant, o.idx)
        .accounts({
          market,
          orderbook,
          yesMint,
          usdcMint,
          userUsdc,
          userYes,
          usdcEscrow,
          yesEscrow,
          user: anchor.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      cancelled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Cancel signatures vary across IDL revisions — log and continue.
      process.stderr.write(`[mm] cancel(${o.side}@${o.order.price}) skipped: ${msg}\n`);
    }
  }
  return cancelled;
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keypairPath = pickKeypairPath();

  process.stderr.write(
    `[mm] starting MM bot for ${args.ticker} @ ${args.strikeCents}¢ (expiry ${new Date(args.expiryTs * 1000).toISOString()})\n`,
  );
  process.stderr.write(`[mm] signer: ${keypairPath}\n`);

  let anchor;
  try {
    anchor = buildAnchorContext(keypairPath);
  } catch (err) {
    process.stderr.write(
      `[mm] anchor unavailable: ${err instanceof Error ? err.message : err}\n`,
    );
    process.stderr.write(
      `[mm] dry-run quote calculation:\n${JSON.stringify(
        quoteBothSides(
          args.midCents ?? 50,
          args.spreadCents,
          args.sizeContracts,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
    process.stderr.write(`[mm] program not deployed — exiting\n`);
    return;
  }

  const [market] = marketPda(
    anchor.programId,
    args.ticker,
    args.strikeCents,
    args.expiryTs,
  );
  const [yesMint] = yesMintPda(anchor.programId, market);
  const [noMint] = noMintPda(anchor.programId, market);
  if (!process.env.USDC_MINT) {
    throw new Error("USDC_MINT not set in env");
  }
  const usdcMint = new PublicKey(process.env.USDC_MINT);

  process.stderr.write(`[mm] market PDA: ${market.toBase58()}\n`);

  const feeDestination = await fetchFeeDestination(anchor);
  if (!feeDestination) {
    process.stderr.write(
      `[mm] could not read fee_destination from Config — place_order will fail. Is the program initialized?\n`,
    );
  } else {
    process.stderr.write(`[mm] fee_destination: ${feeDestination.toBase58()}\n`);
  }

  await mintPairsIfRequested(anchor, market, yesMint, noMint, usdcMint, args.mintPairs);

  let running = true;
  const shutdown = async () => {
    if (!running) return;
    running = false;
    process.stderr.write(`[mm] shutting down — cancelling open orders…\n`);
    try {
      const book = await readBook(anchor, market);
      const n = await cancelOwnOrders(anchor, market, yesMint, usdcMint, book);
      process.stderr.write(`[mm] cancelled ${n} orders\n`);
    } catch (err) {
      process.stderr.write(
        `[mm] cancel-on-shutdown failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    const tick = Date.now();
    try {
      const book = await readBook(anchor, market);
      const bookMid =
        book.bestBid && book.bestAsk
          ? Math.round((book.bestBid.price + book.bestAsk.price) / 2)
          : null;
      const mid = bookMid ?? args.midCents ?? 50;

      process.stderr.write(
        `[mm] tick: bestBid=${book.bestBid?.price ?? "-"} bestAsk=${book.bestAsk?.price ?? "-"} mid=${mid}\n`,
      );

      const cancelled = await cancelOwnOrders(anchor, market, yesMint, usdcMint, book);
      const { bid, ask } = quoteBothSides(mid, args.spreadCents, args.sizeContracts);

      const bidSig = feeDestination
        ? await placeOrderSafe(anchor, {
            market,
            yesMint,
            noMint,
            usdcMint,
            feeDestination,
            side: "bid",
            price: bid.price,
            size: bid.size,
          })
        : null;
      const askSig = feeDestination
        ? await placeOrderSafe(anchor, {
            market,
            yesMint,
            noMint,
            usdcMint,
            feeDestination,
            side: "ask",
            price: ask.price,
            size: ask.size,
          })
        : null;

      process.stderr.write(
        `[mm] quoted bid=${bid.price}¢/${bid.size} (${bidSig?.slice(0, 8) ?? "FAIL"}) ` +
          `ask=${ask.price}¢/${ask.size} (${askSig?.slice(0, 8) ?? "FAIL"}) | cancelled=${cancelled}\n`,
      );

      if (args.deltaHedge) {
        const spot = args.underlyingSpot ?? args.strikeCents / 100;
        const strike = args.strikeCents / 100;
        const deltaPerYes = binaryYesDelta(spot, strike, args.dailyVol);
        // After this round-trip the net Yes exposure if both sides fill = 0.
        // If only the ask fills: short Yes by `size`; if only bid: long by
        // `size`. We hedge against the WORST one-sided fill.
        const worstYesNet = -args.sizeContracts; // short Yes if asks fill
        const portfolioDelta = worstYesNet * deltaPerYes;
        const hedgeUsd = portfolioDelta * spot; // approximate notional
        process.stderr.write(
          `[mm:hedge] delta_per_yes=${deltaPerYes.toFixed(5)} worst_portfolio_delta=${portfolioDelta.toFixed(4)} hedge_notional_usd≈${hedgeUsd.toFixed(2)} (would short ${Math.abs(hedgeUsd / spot).toFixed(2)} shares of ${args.ticker} on Drift)\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[mm] loop error: ${err instanceof Error ? err.message : err}\n`,
      );
    }

    if (args.once) break;
    const elapsed = Date.now() - tick;
    const wait = Math.max(0, args.loopSeconds * 1000 - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }

  await shutdown();
}

main().catch((err) => {
  process.stderr.write(`[mm] fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
