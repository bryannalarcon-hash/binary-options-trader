/**
 * USDC balance hook.
 *
 * Reads the connected wallet's USDC SPL token account balance, refreshing on
 * wallet connect/disconnect and on a slow poll (15s) until WebSocket
 * subscriptions are wired in `app/lib/realtime.ts`.
 *
 * Falls back to a deterministic mock balance when:
 *  - no USDC mint env var is set (localnet without the mint deployed), OR
 *  - the wallet is connected but the token account doesn't exist yet
 *
 * The mock is keyed on the wallet pubkey so the value is stable.
 */

"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TokenAccountNotFoundError } from "@solana/spl-token";

import { env } from "./env";
import { useMounted } from "./use-mounted";

interface UsdcState {
  /** USDC cents (so $12.34 → 1234). */
  cents: number | null;
  loading: boolean;
  error: string | null;
}

const MOCK_BASE_CENTS = 1_000_00; // $1,000.00 default starting balance

export function useUsdcBalance(): UsdcState {
  const { connection } = useConnection();
  const mounted = useMounted();
  const wallet = useWallet();
  const publicKey = mounted ? wallet.publicKey : null;
  const [state, setState] = useState<UsdcState>({
    cents: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!mounted || !publicKey) {
      setState({ cents: null, loading: false, error: null });
      return;
    }

    const usdcMintStr = env.usdcMint;
    const fallbackToMock = !usdcMintStr;

    async function read() {
      if (cancelled) return;
      setState((s) => ({ ...s, loading: true, error: null }));

      if (fallbackToMock) {
        // Deterministic mock: hash the wallet pubkey to a stable cents value.
        const seed = publicKey!.toBase58().split("").reduce(
          (a, c) => a + c.charCodeAt(0),
          0,
        );
        const mockCents = MOCK_BASE_CENTS + (seed % 25_000);
        if (!cancelled) {
          setState({ cents: mockCents, loading: false, error: null });
        }
        return;
      }

      try {
        const usdcMint = new PublicKey(usdcMintStr);
        const ata = getAssociatedTokenAddressSync(usdcMint, publicKey!);
        const account = await getAccount(connection, ata);
        // USDC is 6-decimals; cents = lamports / 10_000
        const cents = Number(account.amount) / 10_000;
        if (!cancelled) setState({ cents, loading: false, error: null });
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          if (!cancelled) setState({ cents: 0, loading: false, error: null });
          return;
        }
        if (!cancelled) {
          setState({
            cents: null,
            loading: false,
            error: err instanceof Error ? err.message : "USDC read failed",
          });
        }
      }
    }

    void read();
    const id = window.setInterval(read, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connection, publicKey, mounted]);

  return state;
}
