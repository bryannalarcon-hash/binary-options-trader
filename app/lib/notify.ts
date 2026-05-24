/**
 * Toast helpers — wraps react-hot-toast so callers don't import it directly.
 * See IMPLEMENTATION_PLAN.md §18.4 — info 5s, success 5s, warning 8s, error sticky.
 */

import toast from "react-hot-toast";

export const notify = {
  info(message: string) {
    toast(message, {
      duration: 5_000,
      icon: "ℹ",
    });
  },
  success(message: string) {
    toast.success(message, { duration: 5_000 });
  },
  warning(message: string) {
    toast(message, {
      duration: 8_000,
      icon: "⚠",
      style: {
        background: "#1c1917",
        color: "#fef3c7",
        border: "1px solid #92400e",
      },
    });
  },
  error(message: string) {
    toast.error(message, { duration: Infinity });
  },
  /** Settlement-bell toast — exact PRD copy in §17.6. */
  settlement(opts: {
    ticker: string;
    strike: number;
    settlementPrice: number; // cents
    outcome: "yes" | "no";
    payoutDollars: number;
  }) {
    const strikeUsd = `$${(opts.strike / 100).toFixed(2)}`;
    const priceUsd = `$${(opts.settlementPrice / 100).toFixed(2)}`;
    const winner = opts.outcome === "yes" ? "Yes" : "No";
    const payout = `$${opts.payoutDollars.toFixed(2)}`;
    toast.success(
      `${opts.ticker} > ${strikeUsd} settled at ${priceUsd} — ${winner} wins. You won ${payout}.`,
      { duration: 10_000 },
    );
  },
};
