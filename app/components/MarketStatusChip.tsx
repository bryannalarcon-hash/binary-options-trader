"use client";

import { useEffect, useState } from "react";

import { marketStatus, marketStatusDisplay } from "@/lib/market-hours";
import { useMounted } from "@/lib/use-mounted";

/**
 * Market-status indicator: dot + label reflecting THIS market's tradeability.
 *
 * A SETTLED market is never "LIVE": it shows a muted, non-pulsing "RESOLVED"
 * chip regardless of the wall-clock session, because order entry reverts
 * (AlreadySettled) on-chain. For an unsettled market the chip tracks the live
 * US equity session:
 *
 *   - open      → green pulsing dot + "LIVE"
 *   - pre/post  → amber dot + "PRE-MKT" / "AFTER HRS"
 *   - closed    → grey dot + "CLOSED"
 *   - settled   → grey dot + "RESOLVED" (no pulse, session-independent)
 *
 * Self-gates on `useMounted()` so the time-dependent status never causes an
 * SSR/hydration mismatch — it renders a neutral "LIVE" placeholder server-side
 * (or "RESOLVED" for a settled market, which is time-independent and safe),
 * then resolves to the real session status on the client. Re-evaluates every
 * 30s so the dot flips at the open/close boundary without a page reload.
 */
export function MarketStatusChip({ isSettled = false }: { isSettled?: boolean }) {
  const mounted = useMounted();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // A settled market is session-independent — render the resolved chip on both
  // server and client (no hydration risk, no "LIVE" while resolved).
  if (isSettled) {
    return (
      <span className="chip-status chip-status--closed">
        <span className="dot" />
        RESOLVED
      </span>
    );
  }

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
