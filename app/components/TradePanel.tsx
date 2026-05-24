"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ExternalLink } from "lucide-react";

import type { Side } from "@meridian/types";
import { fmtCents, fmtUsdDollars } from "@/lib/format";
import {
  buildAndSendTrade,
  type BuildTradeArgs,
} from "@/lib/composite-tx";
import { useOrderBook } from "@/lib/markets-client";
import { useHoldingForMarket } from "@/lib/positions-client";
import { useUsdcBalance } from "@/lib/usdc";
import { notify } from "@/lib/notify";
import { bumpTradeCount, useSettings } from "@/lib/settings";
import { explorerTx } from "@/lib/explorer";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";
import { useMounted } from "@/lib/use-mounted";

import { BetPreview } from "./BetPreview";
import { ConfirmTradeModal } from "./ConfirmTradeModal";
import { PositionConstraintModal } from "./PositionConstraintModal";

interface Props {
  ticker: Ticker;
  strike: number; // cents
  /** Optional initial limit price (set by clicking a level in the order book). */
  initialLimitCents?: number | null;
}

const FEE_BPS = 30; // 0.30%

/**
 * TradePanel — the right-rail trade form. Implements all four flows from
 * IMPLEMENTATION_PLAN §5.5:
 *   - Buy Yes
 *   - Buy No  (composite mint_pair + sell Yes)
 *   - Sell Yes
 *   - Sell No (composite buy Yes + redeem_pair)
 *
 * Position-constraint flow (§5.3) opens PositionConstraintModal when the
 * user picks a side they don't already hold but holds the opposite.
 */
export function TradePanel({ ticker, strike, initialLimitCents }: Props) {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const walletModal = useWalletModal();
  const usdc = useUsdcBalance();
  const holding = useHoldingForMarket(ticker, strike);
  const { book } = useOrderBook(ticker, strike);
  const [settings] = useSettings();
  const isConnected = mounted && wallet.connected;

  const [side, setSide] = useState<Side>("yes");
  const [intent, setIntent] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [quantityStr, setQuantityStr] = useState("10");
  const [limitStr, setLimitStr] = useState("50");
  const [showConfirm, setShowConfirm] = useState(false);
  const [showConstraint, setShowConstraint] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Apply external limit-price update (when user clicks a level in the order book).
  useEffect(() => {
    if (initialLimitCents != null) {
      setLimitStr(String(initialLimitCents));
      setOrderType("limit");
    }
  }, [initialLimitCents]);

  // Best-of-book mid (for market-order preview + price impact)
  const bestBid = book?.bids[0]?.price ?? 50;
  const bestAsk = book?.asks[0]?.price ?? 50;
  const midYes = Math.round((bestBid + bestAsk) / 2);

  // Effective yes-side execution price for the preview
  const yesExecution =
    orderType === "limit"
      ? Math.max(1, Math.min(99, Number(limitStr) || 0))
      : intent === "buy"
        ? side === "yes"
          ? bestAsk
          : 100 - bestBid // Buy No = sell Yes at best bid → No price = 100 - bid
        : side === "yes"
          ? bestBid
          : 100 - bestAsk; // Sell No = buy Yes at best ask → No price = 100 - ask

  const qty = Math.max(0, Math.floor(Number(quantityStr) || 0));
  const pricePerToken = side === "yes" ? yesExecution : 100 - yesExecution;
  const costDollars = (pricePerToken * qty) / 100;
  const feeDollars = (costDollars * FEE_BPS) / 10_000;
  const requiredUsdcCents = Math.ceil((costDollars + feeDollars) * 100);

  // Settled markets get the trade panel replaced with a banner upstream;
  // here we still need a guard for the no-wallet case + insufficient balance.
  const notConnected = !isConnected;
  const insufficient =
    intent === "buy" &&
    usdc.cents != null &&
    requiredUsdcCents > usdc.cents;

  function handleSideClick(nextSide: Side, nextIntent: "buy" | "sell") {
    setSide(nextSide);
    setIntent(nextIntent);
  }

  function handleSubmit() {
    if (notConnected) {
      walletModal.setVisible(true);
      return;
    }
    if (qty <= 0) {
      notify.warning("Enter a quantity > 0");
      return;
    }
    // Position-constraint check: PRD §2.10 + plan §5.3
    if (intent === "buy") {
      if (side === "yes" && holding.no > 0) {
        setShowConstraint(true);
        return;
      }
      if (side === "no" && holding.yes > 0) {
        setShowConstraint(true);
        return;
      }
    }
    // Confirm-trade modal for the first 3 trades only
    if (settings.confirmTradeModal && settings.tradesCompleted < 3) {
      setShowConfirm(true);
      return;
    }
    void executeTrade();
  }

  async function executeTrade() {
    const args: BuildTradeArgs = {
      ticker,
      strike,
      side,
      intent,
      orderType,
      quantity: qty,
      limitPriceCents:
        orderType === "limit" ? Number(limitStr) : undefined,
      slippageBps: settings.slippageBps,
    };
    setSubmitting(true);
    try {
      const res = await buildAndSendTrade(connection, wallet, args);
      bumpTradeCount();
      notify.success(
        `${labelForButton(side, intent)} • avg ${fmtCents(res.avgFillCents)} ` +
          `• ${qty} tokens`,
      );
      // Inline explorer link as a follow-up info toast
      notify.info(`Tx: ${res.signature.slice(0, 16)}…`);
      console.info("Tx:", explorerTx(res.signature));
    } catch (err) {
      notify.error(
        `Trade failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      setSubmitting(false);
      setShowConfirm(false);
    }
  }

  const buttons: { side: Side; intent: "buy" | "sell"; label: string; tone: string }[] = [
    { side: "yes", intent: "buy", label: "Buy Yes", tone: "bg-yes/15 text-yes border-yes/40 hover:bg-yes/25" },
    { side: "no", intent: "buy", label: "Buy No", tone: "bg-no/15 text-no border-no/40 hover:bg-no/25" },
    { side: "yes", intent: "sell", label: "Sell Yes", tone: "border-border text-zinc-300 hover:bg-bg/60" },
    { side: "no", intent: "sell", label: "Sell No", tone: "border-border text-zinc-300 hover:bg-bg/60" },
  ];

  return (
    <aside className="rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Trade {ticker}</h2>
        <p className="text-xs text-zinc-500">
          Strike ${(strike / 100).toFixed(2)} — {TICKER_NAME[ticker]}
        </p>
      </div>

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          {buttons.map((b) => {
            const selected = b.side === side && b.intent === intent;
            return (
              <button
                key={b.label}
                type="button"
                onClick={() => handleSideClick(b.side, b.intent)}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${b.tone} ${
                  selected ? "ring-2 ring-offset-1 ring-offset-surface ring-accent" : ""
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        <div className="inline-flex w-full rounded-md border border-border bg-bg p-0.5 text-xs">
          {(["market", "limit"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setOrderType(t)}
              className={`flex-1 rounded px-2 py-1.5 transition-colors ${
                orderType === t
                  ? "bg-surface text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t === "market" ? "Market" : "Limit"}
            </button>
          ))}
        </div>

        <label className="block text-xs">
          <span className="mb-1 block text-zinc-400">Quantity (tokens)</span>
          <input
            type="number"
            min={1}
            value={quantityStr}
            onChange={(e) => setQuantityStr(e.target.value)}
            className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-accent"
          />
        </label>

        {orderType === "limit" && (
          <label className="block text-xs">
            <span className="mb-1 block text-zinc-400">
              Limit price (cents on Yes side)
            </span>
            <input
              type="number"
              min={1}
              max={99}
              value={limitStr}
              onChange={(e) => setLimitStr(e.target.value)}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-accent"
            />
            <span className="mt-1 block text-[10px] text-zinc-500">
              ≈ {fmtCents(Number(limitStr) || 0)} = {Math.max(0, Math.min(100, Number(limitStr) || 0))}% probability
            </span>
          </label>
        )}

        <BetPreview
          ticker={ticker}
          strike={strike}
          side={side}
          intent={intent}
          quantity={qty}
          avgFillCents={yesExecution}
          feeBps={FEE_BPS}
          probBefore={midYes}
          probAfter={
            side === "yes" && intent === "buy"
              ? Math.min(99, midYes + Math.ceil(qty / 50))
              : side === "yes" && intent === "sell"
                ? Math.max(1, midYes - Math.ceil(qty / 50))
                : side === "no" && intent === "buy"
                  ? Math.max(1, midYes - Math.ceil(qty / 50))
                  : Math.min(99, midYes + Math.ceil(qty / 50))
          }
        />

        {notConnected ? (
          <button
            type="button"
            onClick={() => walletModal.setVisible(true)}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Connect Wallet
          </button>
        ) : insufficient ? (
          <div className="space-y-2">
            <button
              type="button"
              disabled
              className="w-full cursor-not-allowed rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-500"
            >
              Insufficient USDC
            </button>
            <p className="text-[11px] text-zinc-500">
              Need {fmtUsdDollars(requiredUsdcCents / 100)}; you have {fmtUsdDollars((usdc.cents ?? 0) / 100)}.{" "}
              <a
                href="https://faucet.solana.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Get USDC <ExternalLink size={10} className="inline" />
              </a>
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || qty <= 0}
            className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              submitting
                ? "cursor-wait bg-zinc-700 text-zinc-300"
                : "bg-accent text-bg hover:opacity-90"
            }`}
          >
            {submitting
              ? "Submitting…"
              : `${labelForButton(side, intent)} for ${fmtUsdDollars(costDollars)}`}
          </button>
        )}

        {holding.yes + holding.no > 0 && (
          <p className="rounded-md border border-border/50 bg-bg/40 px-3 py-2 text-[11px] text-zinc-400">
            You hold {holding.yes} Yes · {holding.no} No on this strike.
          </p>
        )}
      </div>

      {showConfirm && (
        <ConfirmTradeModal
          ticker={ticker}
          strike={strike}
          side={side}
          intent={intent}
          quantity={qty}
          avgFillCents={yesExecution}
          feeBps={FEE_BPS}
          onConfirm={() => {
            setShowConfirm(false);
            void executeTrade();
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {showConstraint && (
        <PositionConstraintModal
          ticker={ticker}
          strike={strike}
          existingSide={side === "yes" ? "no" : "yes"}
          existingQuantity={side === "yes" ? holding.no : holding.yes}
          newSide={side}
          newQuantity={qty}
          limitPriceCents={
            orderType === "limit" ? Number(limitStr) : undefined
          }
          onClose={() => setShowConstraint(false)}
          onComplete={() => {
            setShowConstraint(false);
            bumpTradeCount();
          }}
        />
      )}
    </aside>
  );
}

function labelForButton(side: Side, intent: "buy" | "sell") {
  if (intent === "buy") return side === "yes" ? "Buy Yes" : "Buy No";
  return side === "yes" ? "Sell Yes" : "Sell No";
}
