"use client";

// Portfolio is wallet-specific; never pre-render at build time.
export const dynamic = "force-dynamic";

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { RefreshCw } from "lucide-react";

import { PositionRow } from "@/components/PositionRow";
import { RedeemConfirmationModal } from "@/components/RedeemConfirmationModal";
import { fmtUsdDollars } from "@/lib/format";
import type { MockPosition } from "@/lib/mock-data";
import { useUserPositions } from "@/lib/positions-client";
import { useSettings } from "@/lib/settings";
import { useMounted } from "@/lib/use-mounted";

/**
 * Portfolio page (`/portfolio`).
 *
 * Implements §16.4:
 *   - Top summary cards (total value, unrealized P&L, realized P&L, open count)
 *   - Active / Settled tabs
 *   - Position rows with Sell + Redeem buttons
 *   - "Redeem All" bulk action
 *   - Auto-redeem + slippage settings sub-section (deep-linked to settings panel)
 */
export default function PortfolioPage() {
  const mounted = useMounted();
  const wallet = useWallet();
  const connected = mounted && wallet.connected;
  const walletModal = useWalletModal();
  const { active, settled, summary, loading } = useUserPositions();
  const [settings, update] = useSettings();
  const [tab, setTab] = useState<"active" | "settled">("active");
  const [redeemTarget, setRedeemTarget] = useState<MockPosition[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!connected) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <div className="rounded-lg border border-dashed border-border bg-surface/40 p-12 text-center">
          <p className="text-zinc-300">Connect a wallet to see your positions.</p>
          <button
            type="button"
            onClick={() => walletModal.setVisible(true)}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Connect Wallet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6" key={refreshKey}>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
          <p className="text-sm text-zinc-500">
            Your active positions, settled outcomes, and P&amp;L.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded-md border border-border p-2 text-zinc-400 hover:text-zinc-100"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          {settled.length > 0 && (
            <button
              type="button"
              onClick={() => setRedeemTarget(settled)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90"
            >
              Redeem All
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard
          label="Total Value"
          value={fmtUsdDollars(summary.totalValueDollars)}
        />
        <SummaryCard
          label="Unrealized P&L"
          value={fmtUsdDollars(summary.unrealizedPnlDollars)}
          tone={summary.unrealizedPnlDollars >= 0 ? "yes" : "no"}
        />
        <SummaryCard
          label="Realized P&L"
          value={fmtUsdDollars(summary.realizedPnlDollars)}
          tone={summary.realizedPnlDollars >= 0 ? "yes" : "no"}
        />
        <SummaryCard
          label="Open Positions"
          value={summary.openCount.toString()}
        />
      </div>

      <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-xs">
        {(["active", "settled"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 transition-colors ${
              tab === t ? "bg-bg text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t === "active"
              ? `Active (${active.length})`
              : `Settled (${settled.length})`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-border bg-surface/60"
            />
          ))}
        </div>
      ) : tab === "active" ? (
        active.length === 0 ? (
          <EmptyState
            primary="No active positions"
            secondary="Place your first trade to see it here."
            cta={{ href: "/markets", label: "Browse Markets" }}
          />
        ) : (
          <div className="space-y-3">
            {active.map((p) => (
              <PositionRow key={`${p.market.address}-${p.side}`} position={p} view="active" />
            ))}
          </div>
        )
      ) : settled.length === 0 ? (
        <EmptyState
          primary="No settled positions yet"
          secondary="Markets settle at 4:00 PM ET — check back after the close."
          cta={{ href: "/markets", label: "Browse Markets" }}
        />
      ) : (
        <div className="space-y-3">
          {settled.map((p) => (
            <PositionRow
              key={`${p.market.address}-${p.side}-settled`}
              position={p}
              view="settled"
              onRedeem={(pos) => setRedeemTarget([pos])}
            />
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Portfolio settings
        </h2>
        <div className="mt-3 space-y-2">
          <label className="flex items-center justify-between text-sm">
            <span className="text-zinc-200">
              Auto-redeem after settlement
              <span className="block text-[11px] text-zinc-500">
                Winning positions auto-redeem to USDC.
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.autoRedeem}
              onChange={(e) => update({ autoRedeem: e.target.checked })}
              className="h-4 w-4 accent-accent"
            />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span className="text-zinc-200">
              Default slippage tolerance
            </span>
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={settings.slippageBps / 100}
                onChange={(e) =>
                  update({
                    slippageBps: Math.max(
                      0,
                      Math.round(Number(e.target.value) * 100),
                    ),
                  })
                }
                className="w-20 rounded border border-border bg-bg px-2 py-1 text-right font-mono text-sm"
              />
              <span className="text-xs text-zinc-500">%</span>
            </span>
          </label>
        </div>
      </div>

      {redeemTarget && (
        <RedeemConfirmationModal
          positions={redeemTarget}
          onClose={() => setRedeemTarget(null)}
          onComplete={() => {
            setRedeemTarget(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "yes" | "no";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-xl ${
          tone === "yes" ? "text-yes" : tone === "no" ? "text-no" : "text-zinc-100"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function EmptyState({
  primary,
  secondary,
  cta,
}: {
  primary: string;
  secondary: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface/40 p-12 text-center">
      <p className="text-sm font-medium text-zinc-200">{primary}</p>
      <p className="mt-1 text-xs text-zinc-500">{secondary}</p>
      {cta && (
        <Link
          href={cta.href}
          className="mt-4 inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}
