"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { WalletError } from "@solana/wallet-adapter-base";

import { env } from "@/lib/env";
import { notify } from "@/lib/notify";
import { BurnerWalletAdapter } from "@/lib/burner-wallet";
import { AdminWalletAdapter } from "@/lib/admin-wallet";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Wraps the app with Solana wallet connection + modal providers.
 *
 * Wallet discovery: we pass an EMPTY adapter array and let
 * `@solana/wallet-adapter-react` (v0.15+) auto-detect Wallet-Standard wallets
 * — Phantom, Solflare, Backpack, etc. all register themselves. Passing the
 * legacy explicit PhantomWalletAdapter/SolflareWalletAdapter alongside the
 * Standard registration caused duplicate/legacy entries that selected but
 * never connected (the "click does nothing" bug).
 *
 * `onError` surfaces wallet failures as a toast instead of swallowing them.
 * Cluster/endpoint come from NEXT_PUBLIC_SOLANA_RPC_URL.
 */
export function WalletProviderWrapper({ children }: { children: ReactNode }) {
  const endpoint = env.rpcUrl || "http://localhost:8899";

  // Burner "Demo Wallet" (no extension) is offered alongside the auto-detected
  // Standard Wallets (Phantom/Solflare/etc.). Only surfaced when a faucet is
  // configured (devnet/localnet) — we never want a keys-in-browser wallet on a
  // mainnet build.
  // Two demo accounts (Demo Wallet 1 / 2) so users can trade with each other
  // (maker ↔ taker) instead of hitting the contract's self-trade guard.
  // Demo Wallet 1/2 (random burners) + an "Admin (demo)" wallet that loads the
  // config-admin keypair (localnet-only, via /api/admin-key) so operators can
  // run oracle/settle/create-market actions in the browser. Only on devnet/
  // localnet (env.faucetUrl set) — never a keys-in-browser wallet on mainnet.
  const wallets = useMemo(
    () =>
      env.faucetUrl
        ? [
            new BurnerWalletAdapter(1),
            new BurnerWalletAdapter(2),
            new AdminWalletAdapter(),
          ]
        : [],
    [],
  );

  const onError = useCallback((error: WalletError) => {
    // WalletNotSelected (a transient select→connect race) and user-rejection are
    // benign — log quietly, no toast. Everything else is a real failure to show.
    const benign = ["WalletNotSelectedError", "WalletConnectionError"];
    if (benign.includes(error?.name)) {
      // eslint-disable-next-line no-console
      console.debug("[wallet]", error?.name);
      return;
    }
    // eslint-disable-next-line no-console
    console.error("[wallet]", error?.name, error?.message);
    notify.error(`Wallet: ${error?.message || error?.name || "connection failed"}`);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
