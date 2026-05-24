/**
 * Number / time formatting helpers.
 *
 * All UI text passes through these so cents↔dollars↔probability is consistent
 * across pages. See IMPLEMENTATION_PLAN.md §18.6 / §18.7.
 */

/** Format USDC cents (0..100) → "$0.65". */
export function fmtUsd(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format USDC dollars → "$12.34". */
export function fmtUsdDollars(dollars: number): string {
  if (!Number.isFinite(dollars)) return "—";
  return `$${dollars.toFixed(2)}`;
}

/** Format a Yes-side price in cents (1..99) → "65¢". */
export function fmtCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `${Math.round(cents)}¢`;
}

/** Cents (1..99) → integer probability percent. */
export function fmtPct(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `${Math.round(cents)}%`;
}

/** Compose the canonical Meridian price display: "65¢ = 65%". */
export function fmtPriceWithProb(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `${fmtCents(cents)} = ${fmtPct(cents)}`;
}

/** Cents → "+1.23%" style change string. */
export function fmtPctChange(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Format a stock-level USD price in cents (e.g. 22050 → "$220.50"). */
export function fmtStockPrice(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format integer count with locale separators. */
export function fmtCount(n: number): string {
  return n.toLocaleString();
}

/** Shorten a base58 pubkey → "AB12…XY34". */
export function shortKey(pk: string | null | undefined, head = 4, tail = 4): string {
  if (!pk) return "—";
  if (pk.length <= head + tail + 1) return pk;
  return `${pk.slice(0, head)}…${pk.slice(-tail)}`;
}

/**
 * Compute milliseconds until the next 4:00 PM ET — the daily settlement bell.
 *
 * Approximation: ET is UTC-5 (EST) most of the year; this code uses UTC-5
 * regardless because we don't ship a DST library on the client. Off-by-one
 * hour during DST is acceptable for the live-tick display.
 */
export function msUntilNext4PmEt(now: Date = new Date()): number {
  const nowUtcMs = now.getTime();
  const ny = new Date(nowUtcMs); // we'll treat times in local UTC and offset
  // 4 PM ET ≈ 21:00 UTC during EST, 20:00 UTC during EDT. Pick 21 for safety.
  const target = new Date(
    Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate(), 21, 0, 0),
  );
  if (target.getTime() <= nowUtcMs) {
    // already past 4 PM ET today — roll to tomorrow
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - nowUtcMs;
}

/** Format ms → "5h 23m" or "0:23:14" depending on how long until. */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "0:00:00";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours >= 1) {
    return `${hours}h ${minutes}m`;
  }
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** ms → relative "3 minutes ago" / "just now". */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  const diffMs = now - ts;
  if (diffMs < 5_000) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** ms timestamp → "Mar 14, 11:23 AM ET" absolute. */
export function fmtAbsolute(ts: number): string {
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${date}, ${time}`;
  } catch {
    return "—";
  }
}
