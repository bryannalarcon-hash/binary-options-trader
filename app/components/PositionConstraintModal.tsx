"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import type { Side } from "@meridian/types";
import { buildCloseAndReverseTrade } from "@/lib/composite-tx";
import { fmtCount } from "@/lib/format";
import { notify } from "@/lib/notify";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";

import { ModalShell } from "./ModalShell";

interface Props {
  ticker: Ticker;
  strike: number;
  existingSide: Side;
  existingQuantity: number;
  newSide: Side;
  newQuantity: number;
  limitPriceCents?: number;
  onClose: () => void;
  onComplete: () => void;
}

/**
 * PositionConstraintModal — fired from TradePanel when the user attempts to
 * buy the side opposite their current holding (§5.3 / §17.2).
 *
 * Offers ONE-tap "Close + Buy" that bundles the close and the buy into a
 * single signed Solana transaction (built by `buildCloseAndReverseTrade`),
 * preserving atomicity and the single-signature UX requirement.
 */
export function PositionConstraintModal({
  ticker,
  strike,
  existingSide,
  existingQuantity,
  newSide,
  newQuantity,
  limitPriceCents,
  onClose,
  onComplete,
}: Props) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [busy, setBusy] = useState(false);

  const existingLabel = existingSide === "yes" ? "Yes" : "No";
  const newLabel = newSide === "yes" ? "Yes" : "No";
  const strikeUsd = `$${(strike / 100).toFixed(2)}`;

  async function handleCloseAndReverse() {
    setBusy(true);
    try {
      const res = await buildCloseAndReverseTrade(connection, wallet, {
        ticker,
        strike,
        side: newSide,
        intent: "buy",
        orderType: limitPriceCents != null ? "limit" : "market",
        quantity: newQuantity,
        limitPriceCents,
        slippageBps: 100,
        existingSide,
        existingQuantity,
      });
      notify.success(
        `Closed ${fmtCount(existingQuantity)} ${existingLabel} → bought ${fmtCount(newQuantity)} ${newLabel} in one tx`,
      );
      notify.info(`Tx: ${res.signature.slice(0, 16)}…`);
      onComplete();
    } catch (err) {
      notify.error(
        `Close+Buy failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Close opposite position first" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="leading-relaxed text-zinc-300">
          You currently hold <strong>{fmtCount(existingQuantity)} {existingLabel}</strong>{" "}
          tokens for {TICKER_NAME[ticker]} ({ticker}) &gt; {strikeUsd}. To buy{" "}
          {newLabel}, you must close your {existingLabel} position first.
        </p>
        <p className="rounded-md border border-accent/30 bg-accent/5 p-3 text-xs leading-relaxed text-zinc-200">
          We&apos;ll bundle this into <strong>one signed transaction</strong>:
          <br />
          <span className="text-zinc-400">
            1. Sell {fmtCount(existingQuantity)} {existingLabel} tokens
            <br />
            2. Buy {fmtCount(newQuantity)} {newLabel} tokens
          </span>
        </p>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-bg/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCloseAndReverse}
            disabled={busy}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              busy ? "cursor-wait bg-zinc-700 text-zinc-300" : "bg-accent text-bg hover:opacity-90"
            }`}
          >
            {busy ? "Submitting…" : `Close ${existingLabel} + Buy ${newLabel}`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
