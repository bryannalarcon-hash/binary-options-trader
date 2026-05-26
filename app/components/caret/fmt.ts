/**
 * Caret formatting helpers (mirrors prototype/js/ui.jsx `fmt$`, `fmtC`, etc).
 *
 * These are dollar/cent helpers; they take *display* numbers (already in
 * dollars / cents on the Yes-side scale) — they do NOT convert from on-chain
 * units. Use lib/format.ts when you have raw on-chain numbers.
 */

export function fmt$(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function fmt$0(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

export function fmtC(c: number): string {
  if (!Number.isFinite(c)) return "—";
  return `${Math.round(c)}¢`;
}

export function fmtPct(n: number, dp = 2, plus = true): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 && plus ? "+" : "";
  return `${sign}${n.toFixed(dp)}%`;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function cToProb(c: number): string {
  return `${Math.round(c)}%`;
}

/** Short pubkey "AB12…XY34" */
export function shortAddr(pk: string | null | undefined, head = 4, tail = 4): string {
  if (!pk) return "—";
  if (pk.length <= head + tail + 1) return pk;
  return `${pk.slice(0, head)}…${pk.slice(-tail)}`;
}

/** Mock sparkline series biased by % change. */
export function mockSpark(chgPct: number, n = 24): number[] {
  const out: number[] = [];
  let v = 50;
  for (let i = 0; i < n; i++) {
    const drift = (chgPct / n) * 4;
    v += drift + (Math.sin(i * 0.4 + chgPct) * 0.8);
    out.push(v);
  }
  return out;
}
