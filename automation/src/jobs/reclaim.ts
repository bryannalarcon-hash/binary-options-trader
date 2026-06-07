// reclaim.ts — daily rent-reclamation job: for every SETTLED market, cancel the
// admin's own resting orders (MM seeds), then `close_settled_book` once the
// book is fully empty so its rent lamports return to the admin. Books holding
// third-party resting orders are skipped (their escrow needs the on-book record).

import { type Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import { env } from "../env";
import { getAnchorContext, isProgramDeployed } from "../lib/anchor";
import { configPda, orderbookPda } from "../lib/pdas";
import { sendHttp } from "../lib/tx";
import { ctx } from "../logger";

const log = ctx("reclaim");

// Local PDA helpers for the bid/ask escrows (not in pdas.ts yet) — mirrors morning.ts.
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

export interface ReclaimSummary {
  /** Order books closed via close_settled_book this pass. */
  closed: number;
  /** Settled books skipped because a third party still has resting orders. */
  skipped: number;
  /** Admin resting orders cancelled (across all markets). */
  cancelled: number;
  /** Admin balance delta over the whole pass (rent reclaimed minus tx fees). */
  lamportsReclaimed: number;
}

/** A non-empty order-book slot: which side, which index, and who owns it. */
interface RestingOrder {
  side: "bid" | "ask";
  index: number;
  owner: PublicKey;
}

/**
 * Reclaim job (~4:30 PM ET, after settle).
 *
 * For each settled market:
 *   1. Fetch its order book (skip silently if already closed).
 *   2. Cancel any resting orders OWNED BY THE ADMIN (unfilled MM seeds) via
 *      `cancel_order`, which also releases the escrowed USDC/YES back.
 *   3. If a third party still has resting orders, warn + skip — closing would
 *      orphan their escrow (cancel_order needs the on-book record).
 *   4. If fully empty, `close_settled_book` — rent lamports return to admin.
 *
 * Each market is wrapped in try/catch so one failure can't kill the pass.
 * Signs with the ADMIN keypair (close_settled_book is admin-only).
 */
export async function runReclaimJob(): Promise<ReclaimSummary> {
  const summary: ReclaimSummary = {
    closed: 0,
    skipped: 0,
    cancelled: 0,
    lamportsReclaimed: 0,
  };

  let anchor;
  try {
    anchor = getAnchorContext(env.adminKeypairPath);
  } catch (err) {
    log.warn(
      { err: errMsg(err) },
      "anchor context unavailable — contract likely not deployed yet",
    );
    return summary;
  }
  if (!(await isProgramDeployed(anchor.connection, anchor.programId))) {
    log.warn(
      { programId: anchor.programId.toBase58() },
      "program not deployed at expected ID — skipping",
    );
    return summary;
  }

  const { program, programId, connection } = anchor;
  const payer: Keypair = (anchor.wallet as any).payer;
  const admin = payer.publicKey;
  const [config] = configPda(programId);

  const balanceBefore = await connection.getBalance(admin);

  const all: Array<{ publicKey: PublicKey; account: any }> =
    await (program.account as any).market.all();
  const settled = all.filter((m) => m.account.settled === true);
  log.info({ settled: settled.length, total: all.length }, "settled markets to inspect");

  for (const { publicKey: market, account } of settled) {
    try {
      const [orderbook] = orderbookPda(programId, market);
      let book = await fetchBook(program, orderbook);
      if (!book) continue; // book already closed in a prior pass

      // 1. Cancel the admin's own resting orders so the book can empty out.
      const adminOrders = restingOrders(book).filter((o) => o.owner.equals(admin));
      if (adminOrders.length > 0) {
        const yesMint: PublicKey = account.yesMint;
        const usdcMint: PublicKey = account.usdcMint;
        const [usdcEscrow] = usdcEscrowPda(programId, market);
        const [yesEscrow] = yesEscrowPda(programId, market);
        const userUsdc = getAssociatedTokenAddressSync(usdcMint, admin);
        const userYes = getAssociatedTokenAddressSync(yesMint, admin);

        for (const order of adminOrders) {
          const cancelIx = await (program.methods as any)
            .cancelOrder(order.side === "bid" ? { bid: {} } : { ask: {} }, order.index)
            .accounts({
              market,
              orderbook,
              yesMint,
              usdcMint,
              userUsdc,
              userYes,
              usdcEscrow,
              yesEscrow,
              user: admin,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction();
          await sendHttp(connection, payer, [cancelIx]);
          summary.cancelled++;
        }
        log.info(
          { market: market.toBase58(), ticker: account.ticker, cancelled: adminOrders.length },
          "cancelled admin resting orders",
        );
        book = await fetchBook(program, orderbook);
        if (!book) continue;
      }

      // 2. A third party's resting order pins the book open: closing it would
      //    orphan their escrowed funds (cancel_order needs the on-book record).
      const remaining = restingOrders(book);
      if (remaining.length > 0) {
        log.warn(
          { market: market.toBase58(), count: remaining.length },
          "book has third-party resting orders — skipping close",
        );
        summary.skipped++;
        continue;
      }

      // 3. Fully empty — close the book; rent returns to admin (`close = admin`).
      const closeIx = await (program.methods as any)
        .closeSettledBook()
        .accounts({
          config,
          market,
          orderbook,
          admin,
        })
        .instruction();
      await sendHttp(connection, payer, [closeIx]);
      summary.closed++;
      log.info(
        { market: market.toBase58(), ticker: account.ticker },
        "closed settled order book",
      );
    } catch (err) {
      log.error(
        { market: market.toBase58(), err: errMsg(err) },
        "reclaim failed for market — continuing",
      );
    }
  }

  const balanceAfter = await connection.getBalance(admin);
  summary.lamportsReclaimed = balanceAfter - balanceBefore;
  log.info(
    {
      closed: summary.closed,
      skipped: summary.skipped,
      cancelled: summary.cancelled,
      lamportsReclaimed: summary.lamportsReclaimed,
      adminBalanceSol: balanceAfter / LAMPORTS_PER_SOL,
    },
    "reclaim pass complete",
  );
  return summary;
}

/**
 * Fetch an order book, or null if the account no longer exists (already
 * closed). Other errors (RPC failures) rethrow into the per-market catch.
 */
async function fetchBook(program: Program, orderbook: PublicKey): Promise<any | null> {
  try {
    return await (program.account as any).orderBook.fetch(orderbook);
  } catch (err) {
    if (errMsg(err).toLowerCase().includes("does not exist")) return null;
    throw err;
  }
}

/**
 * Non-empty slots across both sides of a fetched book. A slot is empty when
 * its owner is the default pubkey AND its size is 0 (mirrors Order::is_empty).
 */
function restingOrders(book: any): RestingOrder[] {
  const out: RestingOrder[] = [];
  for (const side of ["bid", "ask"] as const) {
    const slots: any[] = side === "bid" ? book.bids : book.asks;
    slots.forEach((slot, index) => {
      const owner = new PublicKey(slot.owner);
      const empty = owner.equals(PublicKey.default) && Number(slot.size) === 0;
      if (!empty) out.push({ side, index, owner });
    });
  }
  return out;
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
// CLI entrypoint: `pnpm --filter automation exec tsx src/jobs/reclaim.ts`
// -----------------------------------------------------------------------------
if (require.main === module) {
  runReclaimJob()
    .then((summary) => {
      log.info(summary, "reclaim job finished");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err: errMsg(err) }, "reclaim job crashed");
      process.exit(1);
    });
}
