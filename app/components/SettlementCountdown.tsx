"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

import { fmtCountdown, msUntilNext4PmEt } from "@/lib/format";

interface Props {
  /** Optional explicit expiry timestamp in seconds. Defaults to next 4 PM ET. */
  expiryTs?: number;
  /** Compact mode strips the icon + label, useful inside dense cards. */
  compact?: boolean;
  /** Optional className passthrough. */
  className?: string;
}

/**
 * SettlementCountdown — live ticker to the next settlement bell (4:00 PM ET).
 * Per PRD §2.10 + IMPLEMENTATION_PLAN §16.2: required on every market card.
 *
 * Falls back to "Settled" once the time has passed.
 */
export function SettlementCountdown({ expiryTs, compact, className }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const target = expiryTs ? expiryTs * 1_000 : now + msUntilNext4PmEt(new Date(now));
  const ms = target - now;
  const label = ms <= 0 ? "Settled" : `Settles in ${fmtCountdown(ms)}`;

  if (compact) {
    return (
      <span className={`text-xs text-zinc-400 ${className ?? ""}`}>
        {ms <= 0 ? "Settled" : fmtCountdown(ms)}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-zinc-400 ${className ?? ""}`}
    >
      <Clock size={12} />
      {label}
    </span>
  );
}
