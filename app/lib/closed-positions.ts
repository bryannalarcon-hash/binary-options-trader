// closed-positions.ts — pure derivation of CLOSED-BY-TRADING positions and
// their realized P&L from the user's fill history (HistoryRow stream). The
// portfolio previously realized P&L only at settlement; selling out of a
// position made it vanish with its profit/loss uncounted. Consumed by
// positions-client.ts (useUserPositions) and the portfolio page.

import type { Side } from "@meridian/types";

import type { HistoryRow } from "./history-intent";
import type { Ticker } from "./tickers";

/** One fully- or partially-closed position (aggregated per ticker|strike|side). */
export interface ClosedPosition {
  ticker: Ticker;
  strike: number; // cents
  side: Side;
  /** Total quantity closed by trading (not held to settlement). */
  quantity: number;
  avgEntryCents: number;
  avgExitCents: number;
  realizedDollars: number; // (exit − entry) · qty / 100
  /** Timestamp (ms) of the last closing fill — for ordering / charting. */
  lastTs: number;
}

export interface ClosedDerivation {
  /** Closed positions, newest first. */
  closed: ClosedPosition[];
  /** Sum of realizedDollars across all closed positions. */
  realizedDollars: number;
}

/**
 * Replay filled buy/sell rows oldest → newest with a weighted-average basis
 * (the same convention as deriveCostBasis) and collect realized P&L each time
 * a sell closes against held quantity. Honest accounting only:
 *   - sells beyond known basis are ignored (history truncation — no invented basis);
 *   - mint/redeem pair rows and settlement redemptions are NOT trade closes;
 *   - cancelled rows are ignored.
 */
export function deriveClosedPositions(events: readonly HistoryRow[]): ClosedDerivation {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);

  interface Lot {
    qty: number;
    cost: number; // cents · qty
  }
  interface Bucket {
    closedQty: number;
    entryCost: number; // cents · qty
    exitProceeds: number; // cents · qty
    lastTs: number;
  }
  const open = new Map<string, Lot>();
  const buckets = new Map<string, Bucket>();

  for (const ev of ordered) {
    if (ev.status !== "filled" || !ev.side) continue;
    const k = `${ev.ticker}|${ev.strike}|${ev.side}`;
    if (ev.type === "buy") {
      const lot = open.get(k) ?? { qty: 0, cost: 0 };
      lot.qty += ev.quantity;
      lot.cost += ev.quantity * ev.price;
      open.set(k, lot);
    } else if (ev.type === "sell") {
      const lot = open.get(k);
      if (!lot || lot.qty <= 0) continue; // basis unknown — skip honestly
      const closeQty = Math.min(ev.quantity, lot.qty);
      const avg = lot.cost / lot.qty;
      lot.qty -= closeQty;
      lot.cost -= closeQty * avg;
      if (lot.qty <= 0) open.delete(k);

      const b = buckets.get(k) ?? { closedQty: 0, entryCost: 0, exitProceeds: 0, lastTs: 0 };
      b.closedQty += closeQty;
      b.entryCost += closeQty * avg;
      b.exitProceeds += closeQty * ev.price;
      b.lastTs = Math.max(b.lastTs, ev.ts);
      buckets.set(k, b);
    }
  }

  const closed: ClosedPosition[] = [];
  let total = 0;
  for (const [k, b] of buckets) {
    const [ticker, strikeStr, side] = k.split("|") as [Ticker, string, Side];
    const realized = (b.exitProceeds - b.entryCost) / 100;
    total += realized;
    closed.push({
      ticker,
      strike: Number(strikeStr),
      side,
      quantity: b.closedQty,
      avgEntryCents: Math.round(b.entryCost / b.closedQty),
      avgExitCents: Math.round(b.exitProceeds / b.closedQty),
      realizedDollars: realized,
      lastTs: b.lastTs,
    });
  }
  closed.sort((a, b) => b.lastTs - a.lastTs);
  return { closed, realizedDollars: total };
}
