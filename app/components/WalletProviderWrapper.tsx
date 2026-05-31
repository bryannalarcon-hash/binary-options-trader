"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { WalletError } from "@solana/wallet-adapter-base";

import { env } from "@/lib/env";
import { failoverFetch } from "@/lib/rpc-failover";
import { notify } from "@/lib/notify";
import { BurnerWalletAdapter } from "@/lib/burner-wallet";
import { AdminWalletAdapter } from "@/lib/admin-wallet";

import "@solana/wallet-adapter-react-ui/styles.css";

// Silence the benign RPC-throttling noise @solana/web3.js logs on the free-tier
// devnet endpoint: "ws error: …" on a WebSocket hiccup, and "Server responded
// with 429 … Retrying after Nms delay" when the HTTP RPC rate-limits. web3.js
// retries both automatically and our data hooks fall back to polling, so these
// are console noise, not real failures. Only these exact benign shapes are
// filtered; every other error passes through untouched.
if (typeof window !== "undefined" && !(window as { __wsErrPatched?: boolean }).__wsErrPatched) {
  (window as { __wsErrPatched?: boolean }).__wsErrPatched = true;
  const origError = console.error.bind(console);
  const isBenignRpcNoise = (msg: string): boolean =>
    msg.startsWith("ws error") ||
    msg.startsWith("Server responded with 429") ||
    (msg.includes("429") && msg.includes("Retrying after"));
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && isBenignRpcNoise(args[0])) return;
    origError(...args);
  };
}

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
  const wallets = useMemo(() => {
    if (!env.faucetUrl) return [];
    // Burner "Demo Wallet 1/2" wherever a faucet is configured (localnet + devnet).
    // The "Admin (demo)" wallet fetches the config-admin key from /api/admin-key,
    // which now serves on localnet + devnet (hard-refused only on mainnet — the
    // key is a throwaway devnet/localnet dev key, no real funds). So register it
    // everywhere except a mainnet build.
    const isMainnet =
      env.cluster === "mainnet-beta" ||
      env.cluster === "mainnet" ||
      endpoint.includes("mainnet");
    return isMainnet
      ? [new BurnerWalletAdapter(1), new BurnerWalletAdapter(2)]
      : [new BurnerWalletAdapter(1), new BurnerWalletAdapter(2), new AdminWalletAdapter()];
  }, [endpoint]);

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

  // Route all HTTP RPC through the failover chain (primary → fallback key →
  // public RPC) with a circuit-breaker, and disable web3.js's own 429 retry so
  // it doesn't hammer a capped endpoint — the failover handles routing instead.
  const connectionConfig = useMemo(
    () => ({
      commitment: "confirmed" as const,
      disableRetryOnRateLimit: true,
      fetch: failoverFetch as unknown as typeof fetch,
    }),
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
