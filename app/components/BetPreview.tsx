"use client";

import { fmtCents, fmtPct, fmtUsdDollars } from "@/lib/format";
import type { Side } from "@meridian/types";
import type { Ticker } from "@/lib/tickers";

interface Props {
  ticker: Ticker;
  strike: number; // cents
  side: Side;
  intent: "buy" | "sell";
  quantity: number;
  avgFillCents: number;
  feeBps: number;
  /** Pre-trade and post-trade Yes-side probability, for the price impact line. */
  probBefore: number;
  probAfter: number;
}

/**
 * BetPreview — small summary panel above the Trade panel submit button.
 *
 * Per IMPLEMENTATION_PLAN §16.3 trade-panel row:
 *   - avg fill price
 *   - max payout
 *   - max loss
 *   - fees
 *   - price impact
 *   - PRD-mandated payoff string (verbatim)
 */
export function BetPreview({
  ticker,
  strike,
  side,
  intent,
  quantity,
  avgFillCents,
  feeBps,
  probBefore,
  probAfter,
}: Props) {
  const pricePerToken = side === "yes" ? avgFillCents : 100 - avgFillCents;
  const grossDollars = (pricePerToken * quantity) / 100;
  const feeDollars = (grossDollars * feeBps) / 10_000;
  const netCostDollars = intent === "buy" ? grossDollars + feeDollars : grossDollars - feeDollars;
  const maxPayoutDollars = quantity * 1.0; // each token pays $1 if winning
  const strikeUsd = `$${(strike / 100).toFixed(2)}`;

  // PRD §2.10 EXACT STRING (Yes side):
  //   "You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]."
  // Symmetric No-side string for clarity.
  const payoffString =
    intent === "buy"
      ? side === "yes"
        ? `You pay ${fmtUsdDollars(netCostDollars)}. You win $1.00 if ${ticker} closes above ${strikeUsd}.`
        : `You pay ${fmtUsdDollars(netCostDollars)}. You win $1.00 if ${ticker} closes below ${strikeUsd}.`
      : side === "yes"
        ? `You receive ${fmtUsdDollars(netCostDollars)} for selling ${quantity} Yes tokens.`
        : `You receive ${fmtUsdDollars(netCostDollars)} for selling ${quantity} No tokens.`;

  return (
    <div className="rounded-md border border-border bg-bg/40 p-3 text-xs">
      <ul className="space-y-1 font-mono">
        <li className="flex justify-between">
          <span className="text-zinc-400">Avg fill</span>
          <span>{fmtCents(pricePerToken)}</span>
        </li>
        <li className="flex justify-between">
          <span className="text-zinc-400">Quantity</span>
          <span>{quantity.toLocaleString()}</span>
        </li>
        <li className="flex justify-between">
          <span className="text-zinc-400">{intent === "buy" ? "Cost" : "Proceeds"}</span>
          <span>{fmtUsdDollars(grossDollars)}</span>
        </li>
        <li className="flex justify-between">
          <span className="text-zinc-400">Fee ({(feeBps / 100).toFixed(2)}%)</span>
          <span>{fmtUsdDollars(feeDollars)}</span>
        </li>
        {intent === "buy" && (
          <li className="flex justify-between">
            <span className="text-zinc-400">Max payout if {side === "yes" ? "Yes" : "No"} wins</span>
            <span className="text-yes">{fmtUsdDollars(maxPayoutDollars)}</span>
          </li>
        )}
        <li className="flex justify-between border-t border-border/50 pt-1">
          <span className="text-zinc-400">Price impact</span>
          <span>
            {fmtPct(probBefore)} → {fmtPct(probAfter)}
          </span>
        </li>
      </ul>
      <p className="mt-3 rounded bg-bg/60 p-2 text-xs leading-snug text-zinc-300">
        {payoffString}
      </p>
    </div>
  );
}
