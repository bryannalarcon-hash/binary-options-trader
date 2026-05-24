"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Settings, Wallet as WalletIcon } from "lucide-react";

import { env } from "@/lib/env";
import { fmtUsdDollars, shortKey } from "@/lib/format";
import { useMounted } from "@/lib/use-mounted";
import { useUsdcBalance } from "@/lib/usdc";

import { SettingsPanel } from "./SettingsPanel";

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/history", label: "History" },
];

/**
 * Global header per §16.6.
 *
 * Elements:
 *   - Logo / Brand → /
 *   - Nav links → /markets /portfolio /history with active styling
 *   - Cluster pill (network indicator)
 *   - USDC balance chip (visible when wallet connected)
 *   - Wallet button (connect / address)
 *   - Settings cog → opens SettingsPanel
 */
export function Header() {
  const pathname = usePathname();
  const mounted = useMounted();
  const wallet = useWallet();
  const walletModal = useWalletModal();
  const usdc = useUsdcBalance();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Guard against SSR prerender reading publicKey before hydration.
  const connected = mounted && wallet.connected;
  const publicKey = mounted ? wallet.publicKey : null;
  const disconnect = wallet.disconnect;

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            {env.appName}
          </Link>
          <nav className="hidden gap-6 text-sm md:flex">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`transition-colors ${
                    active ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-border bg-surface px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-400 md:inline">
              {env.cluster || "localnet"}
            </span>
            {connected && (
              <span
                className="hidden items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-mono text-zinc-200 sm:inline-flex"
                title="USDC balance"
              >
                <WalletIcon size={12} className="text-accent" />
                {usdc.loading
                  ? "…"
                  : usdc.cents != null
                    ? fmtUsdDollars(usdc.cents / 100)
                    : "—"}
              </span>
            )}
            {connected && publicKey ? (
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-mono text-zinc-200 hover:bg-bg/60"
                title="Click to disconnect"
              >
                {shortKey(publicKey.toBase58())}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => walletModal.setVisible(true)}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90"
              >
                Connect Wallet
              </button>
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md border border-border bg-surface p-1.5 text-zinc-400 hover:text-zinc-100"
              aria-label="Settings"
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </header>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
