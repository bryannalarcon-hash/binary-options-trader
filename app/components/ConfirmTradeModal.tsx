"use client";

import { useState } from "react";

import type { Side } from "@meridian/types";
import { fmtCents, fmtCount, fmtUsdDollars } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";

import { ModalShell } from "./ModalShell";

interface Props {
  ticker: Ticker;
  strike: number;
  side: Side;
  intent: "buy" | "sell";
  quantity: number;
  avgFillCents: number; // yes-side execution price
  feeBps: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ConfirmTradeModal — first-3-trades safety confirmation per §17.3.
 * "Don't show again" toggle persists to settings.confirmTradeModal=false.
 */
export function ConfirmTradeModal({
  ticker,
  strike,
  side,
  intent,
  quantity,
  avgFillCents,
  feeBps,
  onConfirm,
  onCancel,
}: Props) {
  const [, updateSettings] = useSettings();
  const [dontShow, setDontShow] = useState(false);

  const pricePerToken = side === "yes" ? avgFillCents : 100 - avgFillCents;
  const totalCost = (pricePerToken * quantity) / 100;
  const fee = (totalCost * feeBps) / 10_000;
  const net = intent === "buy" ? totalCost + fee : totalCost - fee;

  function handleConfirm() {
    if (dontShow) {
      updateSettings({ confirmTradeModal: false });
    }
    onConfirm();
  }

  const label =
    intent === "buy"
      ? side === "yes"
        ? "Buy Yes"
        : "Buy No"
      : side === "yes"
        ? "Sell Yes"
        : "Sell No";

  return (
    <ModalShell title="Confirm trade" onClose={onCancel}>
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-border bg-bg/40 p-3">
          <p className="text-3">{TICKER_NAME[ticker]} ({ticker})</p>
          <p className="mt-1 text-base font-medium">
            {label} {fmtCount(quantity)} tokens at strike ${(strike / 100).toFixed(2)}
          </p>
        </div>
        <ul className="space-y-1 font-mono text-xs">
          <li className="flex justify-between">
            <span className="text-3">Avg price</span>
            <span>{fmtCents(pricePerToken)}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-3">Subtotal</span>
            <span>{fmtUsdDollars(totalCost)}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-3">Fee ({(feeBps / 100).toFixed(2)}%)</span>
            <span>{fmtUsdDollars(fee)}</span>
          </li>
          <li className="flex justify-between border-t border-border/50 pt-1 text-text">
            <span>{intent === "buy" ? "Total cost" : "Net proceeds"}</span>
            <span>{fmtUsdDollars(net)}</span>
          </li>
        </ul>
        {intent === "buy" && (
          <p className="rounded bg-bg/60 p-2 text-xs text-2">
            Max payout if {side === "yes" ? "Yes" : "No"} wins:{" "}
            <strong>{fmtUsdDollars(quantity)}</strong>
          </p>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs text-3">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Don&apos;t show again
        </label>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-bg/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Confirm
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
