"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import { buildAndSendRedeem } from "@/lib/composite-tx";
import { fmtUsdDollars } from "@/lib/format";
import { notify } from "@/lib/notify";
import type { Position } from "@/lib/positions-client";

import { ModalShell } from "./ModalShell";

interface Props {
  positions: Position[];
  onClose: () => void;
  onComplete: () => void;
}

/**
 * RedeemConfirmationModal — §17.5.
 * Shows positions about to be redeemed + total USDC payout, then submits
 * one tx per market (Solana doesn't bundle across markets here).
 */
export function RedeemConfirmationModal({ positions, onClose, onComplete }: Props) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [busy, setBusy] = useState(false);

  const totalPayoutDollars = positions.reduce((sum, p) => {
    const winning = p.market.outcome === p.side;
    return sum + (winning ? p.quantity : 0);
  }, 0);

  async function handleConfirm() {
    if (positions.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const res = await buildAndSendRedeem(connection, wallet, {
        markets: positions.map((p) => ({
          address: p.market.address,
          ticker: p.market.ticker,
          strike: p.market.strike,
          side: p.side,
          quantity: p.quantity,
          payoutCents: p.market.outcome === p.side ? p.quantity * 100 : 0,
        })),
      });
      if (res.redeemedCount > 0) {
        notify.success(
          `Redeemed ${res.redeemedCount} position${res.redeemedCount === 1 ? "" : "s"} for ${fmtUsdDollars(res.totalPayoutCents / 100)}` +
            (res.skippedCount > 0 ? ` · ${res.skippedCount} skipped (no balance)` : ""),
        );
        if (res.signature) notify.info(`Tx: ${res.signature.slice(0, 16)}…`);
      }
      if (res.failedCount > 0) {
        notify.error(
          `${res.failedCount} redeem${res.failedCount === 1 ? "" : "s"} failed — see History; the list has been refreshed.`,
        );
      } else if (res.redeemedCount === 0) {
        // Every position had a zero on-chain balance (already redeemed / moved).
        notify.info("Nothing to redeem — these tokens are no longer in your wallet (already redeemed?).");
      }
      // Always refresh + close so a stale row can't be re-clicked into the same
      // error — this is what makes the failure "go away" instead of sticking.
      onComplete();
    } catch (err) {
      notify.error(
        `Redeem failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
      // Refresh underlying positions even on failure so the list reflects reality.
      onComplete();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Redeem settled positions" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-zinc-500">
          Only the <span className="text-zinc-300">winning side</span> of a{" "}
          <span className="text-zinc-300">settled</span> market redeems for $1.00
          per token. Losing or not-yet-settled tokens aren&apos;t redeemable.
        </p>
        {positions.length === 0 ? (
          <p className="text-zinc-400">No settled positions to redeem.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {positions.map((p) => {
              const winning = p.market.outcome === p.side;
              const payout = winning ? p.quantity : 0;
              return (
                <li
                  key={`${p.market.address}-${p.side}`}
                  className="flex items-center justify-between rounded border border-border bg-bg/40 px-3 py-2"
                >
                  <span>
                    {p.market.ticker} &gt; ${(p.market.strike / 100).toFixed(2)}{" "}
                    <span className="text-zinc-500">
                      · {p.side === "yes" ? "Yes" : "No"} · {p.quantity} tokens
                    </span>
                  </span>
                  <span
                    className={winning ? "font-mono text-yes" : "font-mono text-zinc-500"}
                  >
                    {fmtUsdDollars(payout)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {positions.length > 0 && (
          <div className="flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
            <span className="text-zinc-200">Total USDC you&apos;ll receive</span>
            <span className="font-mono text-accent">
              {fmtUsdDollars(totalPayoutDollars)}
            </span>
          </div>
        )}
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
            onClick={handleConfirm}
            disabled={busy || positions.length === 0}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              busy
                ? "cursor-wait bg-zinc-700 text-zinc-300"
                : "bg-accent text-bg hover:opacity-90"
            }`}
          >
            {busy ? "Redeeming…" : "Confirm Redeem"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
