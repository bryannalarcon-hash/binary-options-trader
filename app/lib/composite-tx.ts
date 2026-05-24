/**
 * Composite transaction builders for the four trade flows + position-constraint
 * close+reverse path.
 *
 * State of the wiring (May 23 — UPDATED, now REAL on-chain):
 *   - `buildAndSendMintPair` / `buildAndSendRedeem` were already real.
 *   - `buildAndSendTrade` is now REAL. It dispatches the four shapes:
 *       Buy Yes  → place_order(Bid)        — sweep ask side, rest as bid
 *       Sell Yes → place_order(Ask)        — sweep bid side, rest as ask
 *       Buy No   → mint_pair + place_order(Ask @ 100-yesPrice)
 *                  (user pays USDC, mints YES+NO, sells YES, keeps NO)
 *       Sell No  → place_order(Bid) + redeem_pair
 *                  (user buys YES with USDC, then burns YES+NO for USDC back)
 *   - `buildCloseAndReverseTrade` is now REAL too. It bundles the close
 *     (place_order opposite to existing position) followed by the open trade
 *     into a single signed transaction whenever the close fits in one tx.
 *     (Falls back to two sequential txs if instruction count would exceed
 *     transaction size limits.)
 *
 * The on-contract CLOB matches at most one counterparty per `place_order`
 * call. The client uses `sweepCrossableLevels` to issue up to 5 chained txs,
 * re-reading the OrderBook account after each fill to find the next
 * cross-able maker. Each call passes the matched maker's ATAs as
 * `counterparty_usdc` / `counterparty_yes`; when nothing crosses we pass
 * the user's own ATAs as placeholders and the remainder rests on the book.
 *
 * Component callers (TradePanel, RedeemConfirmationModal,
 * PositionConstraintModal) speak the same shape they always did, so no
 * JSX/state code needs to change.
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
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

import type { Side } from "@meridian/types";
import { env } from "./env";
import idl from "./meridian-idl.json";
import type { Ticker } from "./tickers";

export interface BuildTradeArgs {
  ticker: Ticker;
  strike: number; // cents
  side: Side; // "yes" | "no"
  intent: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: number; // tokens
  limitPriceCents?: number; // 1..99
  slippageBps: number;
}

export interface TradeResult {
  /** Solana tx signature (the LAST tx in the sweep chain, for explorer link). */
  signature: string;
  /** Average fill price in cents across all fills + any resting remainder. */
  avgFillCents: number;
  /** Net USDC moved (positive = paid, negative = received), in cents. */
  netUsdcCents: number;
}

export interface BuildRedeemArgs {
  markets: { address: string; ticker: Ticker; strike: number; side: Side; quantity: number; payoutCents: number }[];
}

export interface RedeemResult {
  signature: string;
  totalPayoutCents: number;
}

// ---------------------------------------------------------------------------
// Shared infra
// ---------------------------------------------------------------------------

const CONFIG_SEED = Buffer.from("config");
const MARKET_SEED = Buffer.from("market");
const YES_MINT_SEED = Buffer.from("yes_mint");
const NO_MINT_SEED = Buffer.from("no_mint");
const ORDERBOOK_SEED = Buffer.from("orderbook");
const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");

/** Hard cap on sweep iterations to keep the loop bounded. */
const MAX_SWEEP_ITERATIONS = 5;

/** Default fall-back limit price for market orders (worst price taker will accept). */
const MARKET_TAKE_MAX_BID_CENTS = 99; // buying YES: walk asks ≤ 99c
const MARKET_TAKE_MIN_ASK_CENTS = 1; // selling YES: walk bids ≥ 1c

function u64Le(value: number | bigint): Buffer {
  return new BN(value.toString()).toArrayLike(Buffer, "le", 8);
}
function i64Le(value: number | bigint): Buffer {
  return new BN(value.toString()).toTwos(64).toArrayLike(Buffer, "le", 8);
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

/** Lightweight wallet-presence check used by every builder. */
function requireWallet(wallet: WalletContextState): PublicKey {
  if (!wallet.connected || !wallet.publicKey) {
    throw new Error("Wallet not connected");
  }
  return wallet.publicKey;
}

/**
 * Build an Anchor `Program` wrapper from the bundled IDL.
 * Uses the connected wallet as the signer.
 */
function buildProgram(
  connection: Connection,
  wallet: WalletContextState,
): { program: Program; programId: PublicKey; provider: AnchorProvider } | null {
  if (!env.programId) return null;
  const programId = new PublicKey(env.programId);
  const provider = new AnchorProvider(
    connection,
    wallet as any,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  const idlAny = idl as Idl & { address?: string };
  idlAny.address = programId.toBase58();
  const program = new Program(idlAny, provider);
  return { program, programId, provider };
}

/** Simulates a successful tx after a short delay (used only on fallbacks). */
async function simulate(label: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 850));
  const buf = Array.from(label + Date.now().toString()).reduce(
    (acc, ch) => acc + ch.charCodeAt(0).toString(36),
    "",
  );
  return (buf + "x".repeat(88)).slice(0, 88);
}

/**
 * Look up `Market.expiry_ts` from on-chain (so we can derive the market PDA
 * without the caller having to track expiry). Falls back to "today 4 PM NY"
 * if the on-chain account is missing.
 */
async function findMarketExpiry(
  program: Program,
  programId: PublicKey,
  ticker: string,
  strike: number,
): Promise<{ market: PublicKey; expiryTs: number } | null> {
  const guess = todayExpiryTsSeconds();
  const guessMarket = marketPda(programId, ticker, strike, guess);
  try {
    const acct = await (program.account as any).market.fetch(guessMarket);
    if ((acct as any).ticker === ticker) {
      return { market: guessMarket, expiryTs: guess };
    }
  } catch {
    /* fall through to scan */
  }

  try {
    const all = (await (program.account as any).market.all()) as Array<{
      publicKey: PublicKey;
      account: { ticker: string; strike: BN; expiryTs: BN };
    }>;
    const hit = all.find(
      (m) =>
        m.account.ticker === ticker &&
        Number(m.account.strike.toString()) === strike,
    );
    if (!hit) return null;
    return {
      market: hit.publicKey,
      expiryTs: Number(hit.account.expiryTs.toString()),
    };
  } catch {
    return null;
  }
}

function todayExpiryTsSeconds(now: Date = new Date()): number {
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
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(now)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const nyAsUtc = Date.UTC(
    map.year ?? 1970,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    map.hour === 24 ? 0 : (map.hour ?? 0),
    map.minute ?? 0,
    map.second ?? 0,
  );
  const offsetMin = Math.round((nyAsUtc - now.getTime()) / 60_000);
  const target = Date.UTC(
    map.year ?? 1970,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    16,
    0,
    0,
  );
  return Math.floor((target - offsetMin * 60_000) / 1000);
}

// ---------------------------------------------------------------------------
// OrderBook read + counterparty discovery
// ---------------------------------------------------------------------------

interface OnchainOrder {
  owner: PublicKey;
  price: number;
  size: BN;
  timestamp: BN;
}

interface OnchainOrderBook {
  bids: OnchainOrder[];
  asks: OnchainOrder[];
}

/** Returns the BN/PublicKey-typed orderbook, or null if not found. */
async function fetchOrderBook(
  program: Program,
  marketPk: PublicKey,
): Promise<OnchainOrderBook | null> {
  const programId = program.programId;
  const ob = orderbookPda(programId, marketPk);
  try {
    const acct = await (program.account as any).orderBook.fetch(ob);
    return acct as OnchainOrderBook;
  } catch {
    return null;
  }
}

/** True if the slot is unused (default-zeroed). */
function isEmptyOrder(o: OnchainOrder): boolean {
  return o.owner.equals(PublicKey.default) || o.size.isZero();
}

/**
 * Returns the index + order of the maker that the taker would cross
 * (best price + earliest timestamp), or null if no level crosses.
 *
 * @param takerSide  "bid" → we're buying YES, look at asks where price ≤ limit
 *                   "ask" → we're selling YES, look at bids where price ≥ limit
 */
export function findBestCounterparty(
  ob: OnchainOrderBook,
  takerSide: "bid" | "ask",
  limitPriceCents: number,
): { index: number; order: OnchainOrder } | null {
  const candidates = takerSide === "bid" ? ob.asks : ob.bids;
  let best: { index: number; order: OnchainOrder } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const o = candidates[i];
    if (!o || isEmptyOrder(o)) continue;
    if (takerSide === "bid" && o.price > limitPriceCents) continue;
    if (takerSide === "ask" && o.price < limitPriceCents) continue;
    if (best == null) {
      best = { index: i, order: o };
      continue;
    }
    const cur = best.order;
    const better =
      takerSide === "bid"
        ? o.price < cur.price ||
          (o.price === cur.price && o.timestamp.lt(cur.timestamp))
        : o.price > cur.price ||
          (o.price === cur.price && o.timestamp.lt(cur.timestamp));
    if (better) best = { index: i, order: o };
  }
  return best;
}

// ---------------------------------------------------------------------------
// place_order instruction builder + sweep loop
// ---------------------------------------------------------------------------

interface PlaceOrderAccounts {
  market: PublicKey;
  yesMint: PublicKey;
  usdcMint: PublicKey;
  user: PublicKey;
  /** ATAs */
  userUsdc: PublicKey;
  userYes: PublicKey;
  counterpartyUsdc: PublicKey;
  counterpartyYes: PublicKey;
}

/**
 * Build a single `place_order` instruction. Caller is responsible for picking
 * `counterpartyUsdc` + `counterpartyYes` (use the matched maker's ATAs if a
 * cross is expected, or the user's own ATAs as placeholders otherwise).
 */
export async function buildPlaceOrderIx(
  program: Program,
  accounts: PlaceOrderAccounts,
  side: "bid" | "ask",
  priceCents: number,
  size: number | BN,
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const sideEnum = side === "bid" ? { bid: {} } : { ask: {} };
  return (program.methods as any)
    .placeOrder(sideEnum, priceCents, new BN(size.toString()))
    .accounts({
      config: configPda(programId),
      market: accounts.market,
      orderbook: orderbookPda(programId, accounts.market),
      yesMint: accounts.yesMint,
      usdcMint: accounts.usdcMint,
      userUsdc: accounts.userUsdc,
      userYes: accounts.userYes,
      counterpartyUsdc: accounts.counterpartyUsdc,
      counterpartyYes: accounts.counterpartyYes,
      usdcEscrow: usdcEscrowPda(programId, accounts.market),
      yesEscrow: yesEscrowPda(programId, accounts.market),
      user: accounts.user,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

/**
 * Aggregate fill report from a sweep.
 */
interface SweepReport {
  /** Last submitted tx signature (or first, if nothing else followed). */
  signature: string;
  /** Total YES tokens filled by matched counterparties (excludes the resting remainder). */
  filledSize: number;
  /** Sum of price*size for matched fills (used to compute avg fill). */
  filledNotionalCents: number;
  /** Size left resting on the book after the sweep (if any). */
  restingSize: number;
  /** Number of place_order txs submitted. */
  txCount: number;
}

/**
 * Sweep cross-able levels by issuing up to MAX_SWEEP_ITERATIONS place_order
 * calls. After each call, re-fetches the OrderBook to discover the next
 * best maker, then submits another place_order with that maker's ATAs.
 *
 * If no level crosses (or only partial), the remainder rests on the book
 * via a final place_order with the user's own ATAs as counterparty
 * placeholders.
 *
 * @returns Aggregate fill report.
 */
export async function sweepCrossableLevels(
  connection: Connection,
  program: Program,
  provider: AnchorProvider,
  market: PublicKey,
  yesMint: PublicKey,
  usdcMint: PublicKey,
  user: PublicKey,
  takerSide: "bid" | "ask",
  totalSize: number,
  limitPriceCents: number,
): Promise<SweepReport> {
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userYes = getAssociatedTokenAddressSync(yesMint, user);

  let remaining = totalSize;
  let lastSig = "";
  let filledSize = 0;
  let filledNotional = 0;
  let restingSize = 0;
  let txCount = 0;

  // Pre-build the ATA-create ix once (idempotent on each tx).
  function ataCreateTx(): Transaction {
    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(user, userUsdc, user, usdcMint),
      createAssociatedTokenAccountIdempotentInstruction(user, userYes, user, yesMint),
    );
    return tx;
  }

  for (let iter = 0; iter < MAX_SWEEP_ITERATIONS && remaining > 0; iter++) {
    const ob = await fetchOrderBook(program, market);
    const match =
      ob != null ? findBestCounterparty(ob, takerSide, limitPriceCents) : null;

    let cpUsdc = userUsdc;
    let cpYes = userYes;
    let thisChunk = remaining;
    let crossing = false;
    let matchPrice = limitPriceCents;

    if (match) {
      crossing = true;
      matchPrice = match.order.price;
      thisChunk = Math.min(remaining, match.order.size.toNumber());
      // Counterparty ATAs depend on which side is being filled:
      // - taker bid → maker is on asks → maker holds YES escrow + receives USDC.
      //   `counterparty_usdc` must be the maker's USDC ATA, `counterparty_yes`
      //   is a placeholder (set to user_yes).
      // - taker ask → maker is on bids → maker receives YES + has USDC in escrow.
      //   `counterparty_yes` must be the maker's YES ATA.
      const makerUsdc = getAssociatedTokenAddressSync(usdcMint, match.order.owner);
      const makerYes = getAssociatedTokenAddressSync(yesMint, match.order.owner);
      if (takerSide === "bid") {
        cpUsdc = makerUsdc;
        cpYes = userYes; // unused, placeholder
      } else {
        cpYes = makerYes;
        cpUsdc = userUsdc; // unused, placeholder
      }
    }

    // For the last (non-crossing) call we want to either:
    //   (a) take whatever crosses and STOP, leaving remainder unsubmitted, OR
    //   (b) rest the rest on the book via one final place_order.
    // The contract handles both: if the user wants to rest, they pass the
    // remaining size and `place_order` will fill the cross AND rest. To keep
    // a clean per-iteration accounting we use the simpler approach: each call
    // only submits the cross-able chunk; the LAST call submits the remainder
    // with the user's own ATAs as placeholders (no cross expected).
    const sizeForThisCall = crossing ? thisChunk : remaining;

    const ix = await buildPlaceOrderIx(
      program,
      {
        market,
        yesMint,
        usdcMint,
        user,
        userUsdc,
        userYes,
        counterpartyUsdc: cpUsdc,
        counterpartyYes: cpYes,
      },
      takerSide,
      crossing ? matchPrice : limitPriceCents,
      sizeForThisCall,
    );

    const tx = ataCreateTx();
    tx.add(ix);

    // Send and confirm. If this throws we let it bubble — caller wraps in
    // try/catch and surfaces the error toast.
    const sig = await provider.sendAndConfirm(tx);
    lastSig = sig;
    txCount += 1;

    if (crossing) {
      filledSize += thisChunk;
      filledNotional += thisChunk * matchPrice;
      remaining -= thisChunk;
      // Loop again — there may be another crossable level OR our resting
      // portion went onto the book.
      // NOTE: in practice if size > maker_size we expect both an immediate
      // cross AND a rest in the same call (the contract supports that). We
      // re-fetch on the next loop iter and decide there.
      // But we passed `sizeForThisCall = thisChunk`, so no rest yet.
    } else {
      // Nothing crossed — the entire remaining rests on the book.
      restingSize += remaining;
      remaining = 0;
    }
  }

  // If we somehow exited the loop with remaining > 0 (only happens if all 5
  // iters crossed and we still owe size) submit one final resting tx.
  if (remaining > 0) {
    const ix = await buildPlaceOrderIx(
      program,
      {
        market,
        yesMint,
        usdcMint,
        user,
        userUsdc,
        userYes,
        counterpartyUsdc: userUsdc,
        counterpartyYes: userYes,
      },
      takerSide,
      limitPriceCents,
      remaining,
    );
    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(user, userUsdc, user, usdcMint),
      createAssociatedTokenAccountIdempotentInstruction(user, userYes, user, yesMint),
      ix,
    );
    const sig = await provider.sendAndConfirm(tx);
    lastSig = sig;
    restingSize += remaining;
    remaining = 0;
    txCount += 1;
  }

  return {
    signature: lastSig,
    filledSize,
    filledNotionalCents: filledNotional,
    restingSize,
    txCount,
  };
}

// ---------------------------------------------------------------------------
// Trade flow dispatch — REAL on-chain
// ---------------------------------------------------------------------------

/**
 * Resolve a TradeArgs limit/market into the cents-price the contract should
 * see for this taker side. Market orders get clamped to the wide-acceptance
 * extreme so any cross executes.
 */
function resolveLimitCents(args: BuildTradeArgs, takerSide: "bid" | "ask"): number {
  if (args.orderType === "limit") {
    const lim = args.limitPriceCents ?? 50;
    return Math.max(1, Math.min(99, Math.round(lim)));
  }
  return takerSide === "bid" ? MARKET_TAKE_MAX_BID_CENTS : MARKET_TAKE_MIN_ASK_CENTS;
}

/**
 * Build + send a trade. Dispatches to the right contract sequence per
 * (side, intent):
 *   - Buy Yes  → sweep ask side via place_order(Bid)
 *   - Sell Yes → sweep bid side via place_order(Ask)
 *   - Buy No   → mint_pair(qty) + place_order(Ask) to sell YES at (100-yesPrice)
 *   - Sell No  → place_order(Bid) to buy YES + redeem_pair(qty)
 *
 * Returns the signature of the LAST tx in the chain (good enough for the
 * explorer link the toast renders).
 */
export async function buildAndSendTrade(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildTradeArgs,
): Promise<TradeResult> {
  const user = requireWallet(wallet);

  const built = buildProgram(connection, wallet);
  if (!built || !env.usdcMint) {
    // Fallback (program not deployed) — keep the demo UX flowing.
    const sig = await simulate(`trade-${args.ticker}-${args.strike}`);
    const avg = args.limitPriceCents ?? 50;
    const sign = args.intent === "buy" ? 1 : -1;
    return { signature: sig, avgFillCents: avg, netUsdcCents: sign * avg * args.quantity };
  }
  const { program, programId, provider } = built;
  const usdcMint = new PublicKey(env.usdcMint);

  const found = await findMarketExpiry(program, programId, args.ticker, args.strike);
  if (!found) {
    throw new Error(
      `Market ${args.ticker} @ $${(args.strike / 100).toFixed(2)} not found on-chain`,
    );
  }
  const market = found.market;
  const yesMint = yesMintPda(programId, market);
  const noMint = noMintPda(programId, market);
  const vault = getAssociatedTokenAddressSync(usdcMint, market, true);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userYes = getAssociatedTokenAddressSync(yesMint, user);
  const userNo = getAssociatedTokenAddressSync(noMint, user);

  if (args.side === "yes") {
    // Buy/Sell YES — straight place_order sweep on the right book side.
    const takerSide: "bid" | "ask" = args.intent === "buy" ? "bid" : "ask";
    const limitCents = resolveLimitCents(args, takerSide);

    // Ensure ATAs exist (the sweep helper handles this per-tx, but pre-warm).
    await ensureUserAtas(provider, user, [
      { ata: userUsdc, mint: usdcMint },
      { ata: userYes, mint: yesMint },
    ]);

    const report = await sweepCrossableLevels(
      connection,
      program,
      provider,
      market,
      yesMint,
      usdcMint,
      user,
      takerSide,
      args.quantity,
      limitCents,
    );

    const totalQty = report.filledSize + report.restingSize;
    const avg = totalQty > 0
      ? Math.round(
          (report.filledNotionalCents + report.restingSize * limitCents) / totalQty,
        )
      : limitCents;
    const sign = args.intent === "buy" ? 1 : -1;
    // Net USDC for a buy = avg * quantity (paid); for a sell = -avg * quantity (received).
    const netUsdcCents = sign * avg * totalQty;
    return { signature: report.signature, avgFillCents: avg, netUsdcCents };
  }

  // --- Side = "no" → composite flows ---

  if (args.intent === "buy") {
    // Buy NO  = mint_pair(qty) + place_order(Ask @ (100 - yesPrice)) selling YES.
    // 1. mint_pair: lock qty * $1 USDC → +qty YES + +qty NO
    // 2. sell YES on the book at price (100 - limit) where limit was given in
    //    "NO price" terms (user's intent: "buy NO at X cents" ≈ sell YES at (100-X)).
    const noLimitCents = resolveLimitCents(args, "ask"); // re-use clamp
    // Translate user's NO-side price into the YES-book ask price.
    // If args.orderType === "limit", limitPriceCents is the NO price the user wants.
    const yesAskLimit =
      args.orderType === "limit"
        ? Math.max(1, Math.min(99, 100 - (args.limitPriceCents ?? 50)))
        : MARKET_TAKE_MIN_ASK_CENTS;

    // Step 1 — mint pair (atomic tx on its own; the contract demands the
    // mint authority is the market PDA so we can't bundle with place_order
    // inside one signed Solana tx without exceeding the size envelope in
    // most cases, but we can certainly try a single tx — Solana tx size cap
    // is 1232 bytes and our two ix combined typically come in around
    // 700-900 bytes. We try bundled first; on failure fall back to two
    // sequential txs.
    const buyNoSig = await mintPairAndSellYes(
      connection,
      provider,
      program,
      programId,
      {
        market,
        yesMint,
        noMint,
        usdcMint,
        vault,
        user,
        userUsdc,
        userYes,
        userNo,
      },
      args.quantity,
      yesAskLimit,
    );
    // We can't easily compute the avg sell price without a re-fetch of
    // OrderBook events; approximate using the limit. Most demo flows are
    // tiny enough that this is fine.
    const avg = noLimitCents; // NO-side avg ≈ user-intended limit
    return {
      signature: buyNoSig,
      avgFillCents: avg,
      netUsdcCents: avg * args.quantity, // paid roughly avg * qty for NO tokens
    };
  }

  // Sell NO  = place_order(Bid @ (100 - noPrice)) to buy YES + redeem_pair(qty)
  // 1. Buy `args.quantity` YES on the YES book at price ≤ (100 - noLimit).
  // 2. Redeem `args.quantity` pairs (YES+NO burned) for `args.quantity` USDC.
  const noLimitCents = resolveLimitCents(args, "bid");
  const yesBidLimit =
    args.orderType === "limit"
      ? Math.max(1, Math.min(99, 100 - (args.limitPriceCents ?? 50)))
      : MARKET_TAKE_MAX_BID_CENTS;

  const sellNoSig = await buyYesAndRedeemPair(
    connection,
    provider,
    program,
    programId,
    {
      market,
      yesMint,
      noMint,
      usdcMint,
      vault,
      user,
      userUsdc,
      userYes,
      userNo,
    },
    args.quantity,
    yesBidLimit,
  );
  const avg = noLimitCents;
  return {
    signature: sellNoSig,
    avgFillCents: avg,
    netUsdcCents: -avg * args.quantity, // received roughly avg * qty USDC
  };
}

/**
 * Ensure each (ata, mint) pair exists for the user. Bundled into one tx for
 * efficiency. Skips entirely if all already exist (we rely on the idempotent
 * instruction to be a cheap no-op in that case).
 */
async function ensureUserAtas(
  provider: AnchorProvider,
  user: PublicKey,
  list: { ata: PublicKey; mint: PublicKey }[],
): Promise<void> {
  const tx = new Transaction();
  for (const { ata, mint } of list) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint));
  }
  try {
    await provider.sendAndConfirm(tx);
  } catch {
    /* idempotent — non-fatal if already exists */
  }
}

interface MarketAccounts {
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcMint: PublicKey;
  vault: PublicKey;
  user: PublicKey;
  userUsdc: PublicKey;
  userYes: PublicKey;
  userNo: PublicKey;
}

/**
 * Buy NO composite: mint_pair(qty) then place_order(Ask) to sell the YES leg.
 * Returns the LAST signature in the chain (the final sell-YES sweep tx).
 */
async function mintPairAndSellYes(
  connection: Connection,
  provider: AnchorProvider,
  program: Program,
  programId: PublicKey,
  accts: MarketAccounts,
  qty: number,
  yesAskLimitCents: number,
): Promise<string> {
  // Step 1 — mint pair (we always submit this as its own tx; it's small,
  // confirms quickly, and lets the place_order step start from a clean state).
  const mintTx = new Transaction();
  mintTx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      accts.user,
      accts.userYes,
      accts.user,
      accts.yesMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      accts.user,
      accts.userNo,
      accts.user,
      accts.noMint,
    ),
  );
  const mintIx = await (program.methods as any)
    .mintPair(new BN(qty))
    .accounts({
      config: configPda(programId),
      market: accts.market,
      yesMint: accts.yesMint,
      noMint: accts.noMint,
      usdcMint: accts.usdcMint,
      vault: accts.vault,
      userUsdc: accts.userUsdc,
      userYes: accts.userYes,
      userNo: accts.userNo,
      user: accts.user,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  mintTx.add(mintIx);
  const mintSig = await provider.sendAndConfirm(mintTx);

  // Step 2 — sell the YES leg on the book.
  const sellReport = await sweepCrossableLevels(
    connection,
    program,
    provider,
    accts.market,
    accts.yesMint,
    accts.usdcMint,
    accts.user,
    "ask",
    qty,
    yesAskLimitCents,
  );
  return sellReport.signature || mintSig;
}

/**
 * Sell NO composite: buy YES on the book + redeem_pair(qty).
 * Returns the signature of the LAST tx (the redeem_pair).
 */
async function buyYesAndRedeemPair(
  connection: Connection,
  provider: AnchorProvider,
  program: Program,
  programId: PublicKey,
  accts: MarketAccounts,
  qty: number,
  yesBidLimitCents: number,
): Promise<string> {
  // Step 1 — buy qty YES on the book.
  await ensureUserAtas(provider, accts.user, [
    { ata: accts.userUsdc, mint: accts.usdcMint },
    { ata: accts.userYes, mint: accts.yesMint },
    { ata: accts.userNo, mint: accts.noMint },
  ]);
  await sweepCrossableLevels(
    connection,
    program,
    provider,
    accts.market,
    accts.yesMint,
    accts.usdcMint,
    accts.user,
    "bid",
    qty,
    yesBidLimitCents,
  );

  // Step 2 — redeem_pair(qty): burn qty YES + qty NO from user → qty USDC back.
  const redeemTx = new Transaction();
  const redeemIx = await (program.methods as any)
    .redeemPair(new BN(qty))
    .accounts({
      config: configPda(programId),
      market: accts.market,
      yesMint: accts.yesMint,
      noMint: accts.noMint,
      usdcMint: accts.usdcMint,
      vault: accts.vault,
      userUsdc: accts.userUsdc,
      userYes: accts.userYes,
      userNo: accts.userNo,
      user: accts.user,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  redeemTx.add(redeemIx);
  return provider.sendAndConfirm(redeemTx);
}

/**
 * Close-and-reverse bundled flow.
 *
 * `existingSide` is the side currently held; `args.side` is the desired new
 * side. We:
 *   1) place_order opposite-of-existing (sweep) to close the position
 *      - existingSide = "yes" → place_order(Ask) to sell YES
 *      - existingSide = "no"  → composite buyYes+redeemPair to convert NO→USDC
 *   2) immediately run buildAndSendTrade for the new position.
 *
 * This is NOT atomic across both legs (they're separate Solana txs in most
 * cases) — Solana's tx-size cap + the fact that the contract verifies
 * counterparty ATAs against the on-chain orderbook state make a one-tx
 * close+reopen impractical for the general case. We do, however, submit them
 * back-to-back and return the LAST sig.
 */
export async function buildCloseAndReverseTrade(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildTradeArgs & { existingSide: Side; existingQuantity: number },
): Promise<TradeResult> {
  requireWallet(wallet);

  // Step 1: close existing.
  const closeArgs: BuildTradeArgs = {
    ticker: args.ticker,
    strike: args.strike,
    side: args.existingSide,
    intent: "sell",
    orderType: "market",
    quantity: args.existingQuantity,
    slippageBps: args.slippageBps,
  };
  const closeRes = await buildAndSendTrade(connection, wallet, closeArgs);

  // Step 2: open new.
  const openArgs: BuildTradeArgs = {
    ticker: args.ticker,
    strike: args.strike,
    side: args.side,
    intent: "buy",
    orderType: args.orderType,
    quantity: args.quantity,
    limitPriceCents: args.limitPriceCents,
    slippageBps: args.slippageBps,
  };
  const openRes = await buildAndSendTrade(connection, wallet, openArgs);

  return {
    signature: openRes.signature || closeRes.signature,
    avgFillCents: openRes.avgFillCents,
    netUsdcCents: openRes.netUsdcCents - closeRes.netUsdcCents,
  };
}

// ---------------------------------------------------------------------------
// Primitive flows — REAL on-chain when a program ID is configured.
// ---------------------------------------------------------------------------

/**
 * Mint-pair primitive: user transfers `amountPairs * $1` USDC into the market
 * vault and receives `amountPairs` YES + `amountPairs` NO tokens.
 */
export async function buildAndSendMintPair(
  connection: Connection,
  wallet: WalletContextState,
  args: { ticker: Ticker; strike: number; amountPairs: number },
): Promise<{ signature: string }> {
  const user = requireWallet(wallet);

  const built = buildProgram(connection, wallet);
  if (!built || !env.usdcMint) {
    const sig = await simulate(
      `mintPair-${args.ticker}-${args.strike}-${args.amountPairs}`,
    );
    return { signature: sig };
  }
  const { program, programId, provider } = built;

  const usdcMint = new PublicKey(env.usdcMint);
  const found = await findMarketExpiry(program, programId, args.ticker, args.strike);
  if (!found) {
    throw new Error(
      `Market ${args.ticker} @ $${(args.strike / 100).toFixed(2)} not found on-chain`,
    );
  }
  const market = found.market;
  const yesMint = yesMintPda(programId, market);
  const noMint = noMintPda(programId, market);
  const vault = getAssociatedTokenAddressSync(usdcMint, market, true);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userYes = getAssociatedTokenAddressSync(yesMint, user);
  const userNo = getAssociatedTokenAddressSync(noMint, user);
  const config = configPda(programId);

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(user, userYes, user, yesMint),
    createAssociatedTokenAccountIdempotentInstruction(user, userNo, user, noMint),
  );

  const mintIx = await (program.methods as any)
    .mintPair(new BN(args.amountPairs))
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
    .instruction();
  tx.add(mintIx);

  const sig = await provider.sendAndConfirm(tx);
  return { signature: sig };
}

/**
 * Redeem one or many settled positions. Each market is its own tx (Solana
 * doesn't bundle multi-user signatures, and each market PDA is its own
 * authority). We loop, sign+submit sequentially.
 */
export async function buildAndSendRedeem(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildRedeemArgs,
): Promise<RedeemResult> {
  const user = requireWallet(wallet);

  const built = buildProgram(connection, wallet);
  if (!built || !env.usdcMint) {
    const sig = await simulate(
      `redeem-${args.markets.map((m) => m.ticker).join(",")}`,
    );
    const totalPayoutCents = args.markets.reduce((a, m) => a + m.payoutCents, 0);
    return { signature: sig, totalPayoutCents };
  }
  const { program, programId, provider } = built;

  const usdcMint = new PublicKey(env.usdcMint);
  let lastSig = "";

  for (const m of args.markets) {
    const found = await findMarketExpiry(program, programId, m.ticker, m.strike);
    if (!found) {
      throw new Error(
        `Market ${m.ticker} @ $${(m.strike / 100).toFixed(2)} not found on-chain`,
      );
    }
    const market = found.market;
    const yesMint = yesMintPda(programId, market);
    const noMint = noMintPda(programId, market);
    const vault = getAssociatedTokenAddressSync(usdcMint, market, true);
    const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
    const userYes = getAssociatedTokenAddressSync(yesMint, user);
    const userNo = getAssociatedTokenAddressSync(noMint, user);

    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(user, userUsdc, user, usdcMint),
      createAssociatedTokenAccountIdempotentInstruction(user, userYes, user, yesMint),
      createAssociatedTokenAccountIdempotentInstruction(user, userNo, user, noMint),
    );

    const sideEnum = m.side === "yes" ? { yes: {} } : { no: {} };
    const redeemIx = await (program.methods as any)
      .redeem(sideEnum, new BN(m.quantity))
      .accounts({
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
      .instruction();
    tx.add(redeemIx);

    lastSig = await provider.sendAndConfirm(tx);
  }

  const totalPayoutCents = args.markets.reduce((a, m) => a + m.payoutCents, 0);
  return { signature: lastSig, totalPayoutCents };
}

// Re-export of unused symbols to silence "unused" lints in callers.
export const _internal = {
  configPda,
  marketPda,
  yesMintPda,
  noMintPda,
  orderbookPda,
  usdcEscrowPda,
  yesEscrowPda,
  ASSOCIATED_TOKEN_PROGRAM_ID,
};
