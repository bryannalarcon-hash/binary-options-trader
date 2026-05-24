"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { ExternalLink } from "lucide-react";

import { notify } from "@/lib/notify";

import { ModalShell } from "./ModalShell";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * WalletConnectModal — list of supported wallets (Phantom, Solflare, Backpack).
 *
 * We surface the wallet adapters that are currently configured in
 * WalletProviderWrapper. If any of them are not installed in the browser,
 * we show an "Install" link instead of "Connect".
 *
 * Per §17.1: X / outside-click / ESC all dismiss.
 */
export function WalletConnectModal({ open, onClose }: Props) {
  const { wallets, select, connect } = useWallet();

  if (!open) return null;

  async function handleConnect(walletName: string) {
    try {
      // wallet-adapter requires a select() before connect()
      select(walletName as never);
      // Give react state a tick to update before connect()
      await new Promise((r) => setTimeout(r, 50));
      await connect();
      notify.success("Wallet connected");
      onClose();
    } catch (err) {
      notify.error(
        `Wallet connect failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }

  return (
    <ModalShell title="Connect a wallet" onClose={onClose}>
      <div className="space-y-2">
        <p className="text-xs text-zinc-400">
          Meridian supports the Solana wallet standard. Choose one below.
        </p>
        <ul className="space-y-2">
          {wallets.map((w) => {
            const installed = w.readyState === "Installed" || w.readyState === "Loadable";
            return (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  onClick={() => {
                    if (installed) {
                      void handleConnect(w.adapter.name);
                    } else {
                      window.open(w.adapter.url, "_blank", "noopener,noreferrer");
                    }
                  }}
                  className="flex w-full items-center justify-between rounded-md border border-border bg-bg/40 px-3 py-2.5 text-sm transition-colors hover:border-accent"
                >
                  <span className="flex items-center gap-3">
                    {w.adapter.icon && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={w.adapter.icon}
                        alt=""
                        className="h-5 w-5"
                      />
                    )}
                    {w.adapter.name}
                  </span>
                  <span
                    className={
                      installed
                        ? "text-xs text-accent"
                        : "inline-flex items-center gap-1 text-xs text-zinc-500"
                    }
                  >
                    {installed ? "Connect" : (
                      <>
                        Install <ExternalLink size={10} />
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {wallets.length === 0 && (
            <li className="rounded-md border border-border bg-bg/40 p-4 text-xs text-zinc-400">
              No wallet adapters detected. Install{" "}
              <a
                href="https://phantom.app/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Phantom
              </a>{" "}
              or{" "}
              <a
                href="https://solflare.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Solflare
              </a>{" "}
              and reload.
            </li>
          )}
        </ul>
      </div>
    </ModalShell>
  );
}
