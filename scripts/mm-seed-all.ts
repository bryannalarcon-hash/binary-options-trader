#!/usr/bin/env tsx
/**
 * scripts/mm-seed-all.ts — seed a two-sided book on EVERY active strike.
 *
 * The demo's books start empty, so the trade page can only show an oracle-vs-
 * strike ESTIMATE and a market order has nothing to fill. This script acts as a
 * simple automated market maker: for each non-settled market it posts a resting
 * BID and ASK (default size 100 each) around the oracle-implied fair price, so
 * users see a real two-sided market and market orders actually fill.
 *
 * It reuses the same on-chain plumbing as scripts/mm-sdk.ts (place_order /
 * mint_pair / cancel_order), just looped across all markets.
 *
 * Inventory: posting an ASK requires YES tokens in escrow, so the MM mints
 * `size` pairs per market from its USDC (acquiring `size` YES + `size` NO).
 * The MM keeps the NO leg as unhedged inventory — fine for a play-money demo.
 *
 * Signer: MM_KEYPAIR_PATH (preferred) else ADMIN_KEYPAIR_PATH (the admin wallet
 * is bootstrapped with 1,000,000 USDC on localnet, enough to seed every strike).
 *
 * Usage:
 *   pnpm --filter automation exec tsx ../scripts/mm-seed-all.ts            # all tickers
 *   pnpm --filter automation exec tsx ../scripts/mm-seed-all.ts --ticker AAPL
 *   pnpm --filter automation exec tsx ../scripts/mm-seed-all.ts --size 100 --spread 6
 *   pnpm --filter automation exec tsx ../scripts/mm-seed-all.ts --no-reset   # additive (don't cancel own first)
 */
import * as path from "path";
import * as dotenv from "dotenv";

import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { buildAnchorContext, isProgramDeployed } from "../automation/src/lib/anchor";
import {
  configPda,
  oraclePda,
  orderbookPda,
} from "../automation/src/lib/pdas";

type Anchor = ReturnType<typeof buildAnchorContext>;

// Escrow PDAs aren't exported by automation/src/lib/pdas — derive them inline
// (same seeds the contract + composite-tx use).
function usdcEscrowPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_escrow"), market.toBuffer()],
    programId,
  );
}
function yesEscrowPda(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("yes_escrow"), market.toBuffer()],
    programId,
  );
}

interface Args {
  size: number;
  spread: number;
  reset: boolean;
  ticker: string | null;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-reset") flags["no-reset"] = "true";
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return {
    size: flags.size ? Number(flags.size) : 100,
    spread: flags.spread ? Number(flags.spread) : 6,
    reset: flags["no-reset"] !== "true",
    ticker: flags.ticker ? flags.ticker.toUpperCase() : null,
  };
}

const num = (v: any): number =>
  typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v);

/** Clamp a yes-cents value to the contract's legal limit-price domain [1, 99]. */
const clampCents = (c: number): number => Math.max(1, Math.min(99, Math.round(c)));

/** Read the oracle spot (USD) for a ticker, or null if missing. */
async function readSpotUsd(anchor: Anchor, ticker: string): Promise<number | null> {
  const [oracle] = oraclePda(anchor.programId, ticker);
  try {
    const acc: any = await (anchor.program.account as any).oracleAccount.fetch(oracle);
    return num(acc.price) / 100; // price stored in cents (expo -2)
  } catch {
    return null;
  }
}

/**
 * Fair YES mid (cents) for a strike from oracle spot vs strike — the same
 * monotonic proxy the UI uses for an empty book. Falls back to 50 (coin-flip)
 * when the oracle is unavailable.
 */
function fairMidCents(spotUsd: number | null, strikeCents: number): number {
  if (spotUsd == null) return 50;
  const strikeUsd = strikeCents / 100;
  const diffPct = ((spotUsd - strikeUsd) / strikeUsd) * 100;
  return clampCents(50 + diffPct * 4);
}

/** bid/ask around mid ± spread/2, clamped so 1 <= bid < ask <= 99. */
function quote(midCents: number, spreadCents: number): { bid: number; ask: number } {
  const half = Math.max(1, Math.floor(spreadCents / 2));
  let bid = clampCents(midCents - half);
  let ask = clampCents(midCents + half);
  if (ask <= bid) {
    // Degenerate near an extreme — nudge to a legal 1-tick market.
    bid = clampCents(Math.min(bid, 98));
    ask = clampCents(bid + 1);
  }
  return { bid, ask };
}

interface BookSide {
  price: number;
  size: number;
  owner: PublicKey;
  idx: number;
}

async function readBook(
  anchor: Anchor,
  market: PublicKey,
): Promise<{ bids: BookSide[]; asks: BookSide[] }> {
  const [orderbook] = orderbookPda(anchor.programId, market);
  try {
    const raw: any = await (anchor.program.account as any).orderBook.fetch(orderbook);
    const decode = (arr: any[]): BookSide[] =>
      (arr || [])
        .map((o, idx) => ({
          price: num(o.price),
          size: num(o.size),
          owner: o.owner as PublicKey,
          idx,
        }))
        .filter((o) => o.size > 0 && !o.owner.equals(PublicKey.default));
    return { bids: decode(raw.bids), asks: decode(raw.asks) };
  } catch {
    return { bids: [], asks: [] };
  }
}

/** Cancel the MM's own resting orders on a market (frees locked USDC + YES). */
async function cancelOwn(
  anchor: Anchor,
  market: PublicKey,
  yesMint: PublicKey,
  usdcMint: PublicKey,
): Promise<number> {
  const me = anchor.wallet.publicKey;
  const book = await readBook(anchor, market);
  const [orderbook] = orderbookPda(anchor.programId, market);
  const [usdcEscrow] = usdcEscrowPda(anchor.programId, market);
  const [yesEscrow] = yesEscrowPda(anchor.programId, market);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, me, false);
  const userYes = getAssociatedTokenAddressSync(yesMint, me, false);

  const mine = [
    ...book.bids.filter((o) => o.owner.equals(me)).map((o) => ({ ...o, side: "bid" as const })),
    ...book.asks.filter((o) => o.owner.equals(me)).map((o) => ({ ...o, side: "ask" as const })),
  ];
  let n = 0;
  for (const o of mine) {
    try {
      await (anchor.program.methods as any)
        .cancelOrder(o.side === "bid" ? { bid: {} } : { ask: {} }, o.idx)
        .accounts({
          market,
          orderbook,
          yesMint,
          usdcMint,
          userUsdc,
          userYes,
          usdcEscrow,
          yesEscrow,
          user: me,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      n++;
    } catch {
      /* index may have shifted under us — best-effort */
    }
  }
  return n;
}

/** Ensure the MM holds at least `size` free YES on this market; mint if short. */
async function ensureYesInventory(
  anchor: Anchor,
  market: PublicKey,
  yesMint: PublicKey,
  noMint: PublicKey,
  usdcMint: PublicKey,
  size: number,
): Promise<void> {
  const me = anchor.wallet.publicKey;
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, me, false);
  const userYes = getAssociatedTokenAddressSync(yesMint, me, false);
  const userNo = getAssociatedTokenAddressSync(noMint, me, false);

  // mint_pair + place_order require the user ATAs to already exist.
  await anchor.provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(me, userUsdc, me, usdcMint),
      createAssociatedTokenAccountIdempotentInstruction(me, userYes, me, yesMint),
      createAssociatedTokenAccountIdempotentInstruction(me, userNo, me, noMint),
    ),
  );

  let have = 0;
  try {
    have = Number((await getAccount(anchor.connection, userYes)).amount);
  } catch {
    have = 0;
  }
  if (have >= size) return;

  const need = size - have;
  const [config] = configPda(anchor.programId);
  const vault = getAssociatedTokenAddressSync(usdcMint, market, true);
  await (anchor.program.methods as any)
    .mintPair(new BN(need))
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
      user: me,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

async function placeOrder(
  anchor: Anchor,
  market: PublicKey,
  yesMint: PublicKey,
  noMint: PublicKey,
  usdcMint: PublicKey,
  feeDestination: PublicKey,
  side: "bid" | "ask",
  price: number,
  size: number,
): Promise<void> {
  const me = anchor.wallet.publicKey;
  const [config] = configPda(anchor.programId);
  const [orderbook] = orderbookPda(anchor.programId, market);
  const [usdcEscrow] = usdcEscrowPda(anchor.programId, market);
  const [yesEscrow] = yesEscrowPda(anchor.programId, market);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, me, false);
  const userYes = getAssociatedTokenAddressSync(yesMint, me, false);
  const userNo = getAssociatedTokenAddressSync(noMint, me, false);
  const feeDestinationUsdc = getAssociatedTokenAddressSync(usdcMint, feeDestination, true);

  // Bundle idempotent ATA creation (place_order's position guard reads
  // `user_no`, which must exist) with the order in one tx.
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, userUsdc, me, usdcMint),
    createAssociatedTokenAccountIdempotentInstruction(me, userYes, me, yesMint),
    createAssociatedTokenAccountIdempotentInstruction(me, userNo, me, noMint),
  );
  const ix = await (anchor.program.methods as any)
    .placeOrder(side === "bid" ? { bid: {} } : { ask: {} }, price, new BN(size))
    .accounts({
      config,
      market,
      orderbook,
      yesMint,
      noMint,
      usdcMint,
      userUsdc,
      userYes,
      userNo,
      counterpartyUsdc: userUsdc, // self placeholder — no cross at post time
      counterpartyYes: userYes,
      usdcEscrow,
      yesEscrow,
      feeDestinationUsdc,
      user: me,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  tx.add(ix);
  await anchor.provider.sendAndConfirm(tx);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.USDC_MINT) throw new Error("USDC_MINT not set in env");
  const usdcMint = new PublicKey(process.env.USDC_MINT);

  const keypairPath =
    process.env.MM_KEYPAIR_PATH?.trim() || process.env.ADMIN_KEYPAIR_PATH?.trim();
  if (!keypairPath) throw new Error("Set MM_KEYPAIR_PATH or ADMIN_KEYPAIR_PATH");

  const anchor = buildAnchorContext(keypairPath);
  if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
    throw new Error("program not deployed");
  }
  console.log(`[mm-seed] signer ${anchor.wallet.publicKey.toBase58()} · size=${args.size} spread=${args.spread}¢ reset=${args.reset}`);

  // fee_destination from Config (place_order routes the taker fee there).
  const [config] = configPda(anchor.programId);
  const cfg: any = await (anchor.program.account as any).config.fetch(config);
  const feeDestination: PublicKey = cfg.feeDestination;

  const markets: Array<{ publicKey: PublicKey; account: any }> =
    await (anchor.program.account as any).market.all();
  const active = markets
    .filter((m) => !m.account.settled)
    .filter((m) => !args.ticker || (m.account.ticker as string) === args.ticker)
    .sort((a, b) =>
      (a.account.ticker + num(a.account.strike)).localeCompare(
        b.account.ticker + num(b.account.strike),
      ),
    );

  console.log(`[mm-seed] ${active.length} active markets to seed`);
  let ok = 0;
  let failed = 0;

  for (const m of active) {
    const market = m.publicKey;
    const ticker = m.account.ticker as string;
    const strikeCents = num(m.account.strike);
    const yesMint = m.account.yesMint as PublicKey;
    const noMint = m.account.noMint as PublicKey;
    const label = `${ticker} $${(strikeCents / 100).toFixed(2)}`;

    try {
      const spotUsd = await readSpotUsd(anchor, ticker);
      const mid = fairMidCents(spotUsd, strikeCents);
      const { bid, ask } = quote(mid, args.spread);

      if (args.reset) await cancelOwn(anchor, market, yesMint, usdcMint);

      // Post the BID first, while the MM holds no NO — the contract's book-path
      // guard only fires on a Bid that *acquires* YES while holding NO, so doing
      // this before minting keeps the bid exempt even if it happens to cross.
      await placeOrder(anchor, market, yesMint, noMint, usdcMint, feeDestination, "bid", bid, args.size);
      // Mint YES inventory (this is what leaves the MM holding the NO leg), then
      // post the ASK (an Ask never trips the guard).
      await ensureYesInventory(anchor, market, yesMint, noMint, usdcMint, args.size);
      await placeOrder(anchor, market, yesMint, noMint, usdcMint, feeDestination, "ask", ask, args.size);

      ok++;
      console.log(`[mm-seed] ${label.padEnd(14)} mid=${String(mid).padStart(2)}¢  bid ${bid}¢ / ask ${ask}¢ × ${args.size}  ✓`);
    } catch (err) {
      failed++;
      console.error(`[mm-seed] ${label.padEnd(14)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Gentle pacing so devnet RPCs (Helius free tier) don't 429 the confirms.
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n[mm-seed] done — ${ok} seeded, ${failed} failed of ${active.length} markets.`);
}

main().catch((err) => {
  console.error(`[mm-seed] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
