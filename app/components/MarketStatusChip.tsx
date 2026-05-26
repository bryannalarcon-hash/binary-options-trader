"use client";

import { useEffect, useState } from "react";

import { marketStatus, marketStatusDisplay } from "@/lib/market-hours";
import { useMounted } from "@/lib/use-mounted";

/**
 * Market-status indicator: dot + label that tracks the live US equity session.
 *
 *   - open      → green pulsing dot + "LIVE"
 *   - pre/post  → amber dot + "PRE-MKT" / "AFTER HRS"
 *   - closed    → grey dot + "CLOSED"
 *
 * Self-gates on `useMounted()` so the time-dependent status never causes an
 * SSR/hydration mismatch — it renders a neutral "LIVE" placeholder server-side,
 * then resolves to the real status on the client. Re-evaluates every 30s so the
 * dot flips at the open/close boundary without a page reload.
 */
export function MarketStatusChip() {
  const mounted = useMounted();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Pre-hydration: render the legacy live chip so server/client HTML matches.
  if (!mounted) {
    return (
      <span className="chip-live">
        <span className="dot" />
        LIVE
      </span>
    );
  }

  const status = marketStatus(now);
  const { label, chipClass } = marketStatusDisplay(status);
  return (
    <span className={chipClass}>
      <span className="dot" />
      {label}
    </span>
  );
}
