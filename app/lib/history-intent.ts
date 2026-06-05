// history-intent.ts — pure, tx-scoped translator from raw program events to
// user-intent history rows. The CLOB is quoted in YES terms (Bid = buy YES,
// Ask = sell YES); "No" trades are composites (Buy No = mint_pair + sell YES,
// Sell No = buy YES + redeem_pair). This module reconstructs what the USER did
// from the events of ONE transaction, so history reads "Sold Yes" / "Bought No"
// instead of leaking book mechanics (or mislabeling asks as "No" — the old bug).
// Consumed by positions-client.ts (useUserHistory + cost-basis derivation).

import type { Side } from "@meridian/types";

import type { Ticker } from "./tickers";

/** One decoded history row — mirror of positions-client's HistoryEvent. */
export interface HistoryRow {
  ts: number;
  type: "buy" | "sell" | "mint_pair" | "redeem_pair" | "redeem" | "settle";
  ticker: Ticker;
  strike: number;
  side: Side | null;
  quantity: number;
  price: number; // cents
  feeCents: number;
  status: "filled" | "cancelled" | "failed";
  txSig: string;
}

/** Raw anchor event: `data` values may be PublicKey / BN / plain primitives. */
export interface RawProgramEvent {
  name: string;
  data: Record<string, unknown>;
}

export interface BuildRowsOptions {
  /** Connected wallet, base58. */
  myKey: string;
  txSig: string;
  /** Row timestamp (ms) — pass blockTime*1000 for back-filled txs. */
  ts: number;
  /** Resolve a market address (base58) to its ticker/strike, or undefined. */
  lookupMarket: (address: string) => { ticker: Ticker; strike: number } | undefined;
}

// Duck-typed normalizers so the same code accepts PublicKey/BN in prod and
// plain strings/numbers in tests.
function asStr(v: unknown): string {
  if (v == null) return "";
  const b58 = (v as { toBase58?: () => string }).toBase58;
  return typeof b58 === "function" ? b58.call(v) : String(v);
}
function asNum(v: unknown): number {
  if (v == null) return 0;
  return Number((v as { toString: () => string }).toString());
}

/**
 * Translate one transaction's program events into user-intent history rows.
 *
 * Intent rules (myBookSide: 0 = I bought YES on the book, 1 = I sold YES):
 *   - sold YES + PairMinted(me, market) in the same tx  → **Bought No** @ 100−p
 *   - bought YES + PairRedeemed(me, market) in same tx  → **Sold No**  @ 100−p
 *   - otherwise the book action IS the intent           → Bought/Sold **Yes** @ p
 * Pair rows consumed by a composite are suppressed (they're plumbing, not an
 * action the user took). Maker fills invert the taker's side AND direction —
 * the old decoder used the taker's direction for both parties.
 */
export function buildTxHistoryRows(
  events: RawProgramEvent[],
  opts: BuildRowsOptions,
): HistoryRow[] {
  const { myKey, txSig, ts, lookupMarket } = opts;
  const evs = events.map((e) => ({ name: e.name.toLowerCase(), d: e.data ?? {} }));

  // Markets where this tx minted / pair-redeemed for ME (composite legs).
  const mintedMkts = new Set<string>();
  const pairRedeemedMkts = new Set<string>();
  for (const { name, d } of evs) {
    if (asStr(d.user) !== myKey) continue;
    if (name === "pairminted") mintedMkts.add(asStr(d.market));
    if (name === "pairredeemed") pairRedeemedMkts.add(asStr(d.market));
  }
  const consumedMints = new Set<string>();
  const consumedRedeems = new Set<string>();

  const rows: HistoryRow[] = [];
  const base = (mkt: { ticker: Ticker; strike: number }) => ({
    ts,
    ticker: mkt.ticker,
    strike: mkt.strike,
    feeCents: 0,
    status: "filled" as const,
    txSig,
  });

  for (const { name, d } of evs) {
    const mktAddr = asStr(d.market);
    const mkt = lookupMarket(mktAddr);
    if (!mkt) continue; // unknown market — skip

    switch (name) {
      case "ordermatched": {
        const taker = asStr(d.taker);
        const maker = asStr(d.maker);
        if (taker !== myKey && maker !== myKey) break;
        const takerSide = asNum(d.takerSide ?? (d as Record<string, unknown>)["taker_side"]);
        // Maker sits on the opposite book side from the taker.
        const myBookSide = taker === myKey ? takerSide : 1 - takerSide;
        const p = asNum(d.price);
        const size = asNum(d.size);
        if (myBookSide === 1) {
          // I sold YES on the book.
          if (mintedMkts.has(mktAddr)) {
            consumedMints.add(mktAddr);
            rows.push({ ...base(mkt), type: "buy", side: "no", quantity: size, price: 100 - p });
          } else {
            rows.push({ ...base(mkt), type: "sell", side: "yes", quantity: size, price: p });
          }
        } else {
          // I bought YES on the book.
          if (pairRedeemedMkts.has(mktAddr)) {
            consumedRedeems.add(mktAddr);
            rows.push({ ...base(mkt), type: "sell", side: "no", quantity: size, price: 100 - p });
          } else {
            rows.push({ ...base(mkt), type: "buy", side: "yes", quantity: size, price: p });
          }
        }
        break;
      }
      case "orderplaced": {
        if (asStr(d.user) !== myKey) break;
        const side = asNum(d.side); // 0 = bid (buy YES), 1 = ask (sell YES)
        const p = asNum(d.price);
        const size = asNum(d.size);
        if (side === 1 && mintedMkts.has(mktAddr)) {
          consumedMints.add(mktAddr);
          rows.push({ ...base(mkt), type: "buy", side: "no", quantity: size, price: 100 - p });
        } else if (side === 0 && pairRedeemedMkts.has(mktAddr)) {
          consumedRedeems.add(mktAddr);
          rows.push({ ...base(mkt), type: "sell", side: "no", quantity: size, price: 100 - p });
        } else if (side === 0) {
          rows.push({ ...base(mkt), type: "buy", side: "yes", quantity: size, price: p });
        } else {
          rows.push({ ...base(mkt), type: "sell", side: "yes", quantity: size, price: p });
        }
        break;
      }
      case "ordercancelled": {
        if (asStr(d.user) !== myKey) break;
        const side = asNum(d.side);
        rows.push({
          ...base(mkt),
          type: side === 0 ? "buy" : "sell",
          side: "yes", // book truth; intent unknowable for a cancelled remainder
          quantity: asNum(d.returnedSize ?? (d as Record<string, unknown>)["returned_size"]),
          price: asNum(d.returnedPrice ?? (d as Record<string, unknown>)["returned_price"]),
          status: "cancelled",
        });
        break;
      }
      case "redeemed": {
        // Settlement-winnings (or pre-settle single-side) redemption.
        if (asStr(d.user) !== myKey) break;
        const burned = asNum(d.amountBurned ?? (d as Record<string, unknown>)["amount_burned"]);
        const paid = asNum(d.usdcPaid ?? (d as Record<string, unknown>)["usdc_paid"]);
        rows.push({
          ...base(mkt),
          type: "redeem",
          side: asNum(d.side) === 0 ? "yes" : "no",
          quantity: burned,
          price: burned === 0 ? 0 : Math.round(paid / (burned * 10_000)),
        });
        break;
      }
      default:
        break;
    }
  }

  // Pair mint/redeem rows NOT consumed by a composite classification above —
  // the user minted/redeemed pairs as a standalone action; show it.
  for (const { name, d } of evs) {
    if (asStr(d.user) !== myKey) continue;
    const mktAddr = asStr(d.market);
    const mkt = lookupMarket(mktAddr);
    if (!mkt) continue;
    const amount = asNum(d.amountPairs ?? (d as Record<string, unknown>)["amount_pairs"]);
    if (name === "pairminted" && !consumedMints.has(mktAddr)) {
      rows.push({ ...base(mkt), type: "mint_pair", side: null, quantity: amount, price: 100 });
    } else if (name === "pairredeemed" && !consumedRedeems.has(mktAddr)) {
      rows.push({ ...base(mkt), type: "redeem_pair", side: null, quantity: amount, price: 100 });
    }
  }

  return rows;
}
