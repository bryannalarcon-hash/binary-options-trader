"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

/**
 * Returns true once the component has hydrated on the client.
 *
 * Used to defer reads of wallet context (which the Solana adapter spies on
 * and errors when read during the initial server-rendered HTML pass).
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

/**
 * Whether the wallet connection state has settled enough to render a
 * connected/disconnected decision without flicker.
 *
 * On reload, `autoConnect` re-attaches a previously-selected wallet, but for a
 * brief window `connected` is still false — rendering the "connect wallet"
 * prompt then snapping to the connected view ("flicker right and wrong"). This
 * returns false until either the wallet connects OR a short grace window
 * elapses, so callers can show a stable loading state in between. Self-heals if
 * autoConnect never connects (no persisted wallet / user rejects).
 */
export function useWalletReady(graceMs = 1200): boolean {
  const { connected } = useWallet();
  const mounted = useMounted();
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!mounted) return;
    const t = window.setTimeout(() => setGraceOver(true), graceMs);
    return () => window.clearTimeout(t);
  }, [mounted, graceMs]);
  return mounted && (connected || graceOver);
}
