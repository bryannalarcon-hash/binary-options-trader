"use client";

import { useEffect, useState } from "react";

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
