"use client";

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import { env } from "@/lib/env";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Wraps the app with Solana wallet connection + modal providers.
 *
 * Adapters wired per PRD §2.10 + IMPLEMENTATION_PLAN §17.1:
 *   - Phantom (explicit adapter)
 *   - Solflare (explicit adapter)
 *   - Backpack + any other Wallet-Standard wallet are auto-detected by
 *     `@solana/wallet-adapter-react` and shown in the wallet modal.
 *
 * Configured for localnet by default via NEXT_PUBLIC_SOLANA_RPC_URL.
 */
export function WalletProviderWrapper({ children }: { children: ReactNode }) {
  const endpoint = env.rpcUrl || "http://localhost:8899";
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
