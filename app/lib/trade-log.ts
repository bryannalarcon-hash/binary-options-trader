/**
 * Structured client-side trade-action logger.
 *
 * Every trade dispatch (buy / sell / mint_pair / redeem_pair / redeem / cancel)
 * is logged here at three lifecycle points:
 *   - "submitted": just before the on-chain tx is sent
 *   - "confirmed": once a signature comes back
 *   - "failed":    if the dispatch throws
 *
 * Each entry is emitted to `console.info` as structured JSON AND persisted to a
 * capped in-memory ring buffer + `localStorage` (SSR-guarded). The History page
 * (or a debug panel) can read the local action log via `readTradeLog()` to show
 * the user's own submitted/failed actions alongside the confirmed on-chain
 * events (which the program-log indexer in positions-client.ts surfaces).
 *
 * This module is purely observational — it never touches the transaction
 * building/sending path. composite-tx.ts calls these functions around its
 * existing `provider.sendAndConfirm` logic without altering it.
 */

import type { Side } from "@meridian/types";
import type { Ticker } from "./tickers";

export type TradeLogAction =
  | "buy"
  | "sell"
  | "mint_pair"
  | "redeem_pair"
  | "redeem"
  | "cancel";

export type TradeLogStatus = "submitted" | "confirmed" | "failed";

export interface TradeLogEntry {
  /** Epoch millis when this lifecycle event was logged. */
  ts: number;
  action: TradeLogAction;
  ticker: Ticker;
  /** Strike in cents (0 when not applicable, e.g. a cancel by index). */
  strike: number;
  /** Side for directional actions; null for pair mint/redeem. */
  side: Side | null;
  /** Token quantity (0 when unknown). */
  qty: number;
  /** Price in cents (null when not yet known / not applicable). */
  priceCents: number | null;
  /** Fee in cents (null when not known). */
  feeCents: number | null;
  /** Tx signature — only present on confirm. */
  txSig: string | null;
  status: TradeLogStatus;
  /** Optional error message on failure. */
  error?: string;
}

const STORAGE_KEY = "meridian.trade-log.v1";
const MAX_ENTRIES = 200;

/** In-memory ring buffer (newest first). Survives across components in a session. */
let ring: TradeLogEntry[] = loadFromStorage();

/** Subscribers notified whenever a new entry is appended (for live UI updates). */
const listeners = new Set<() => void>();

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function loadFromStorage(): TradeLogEntry[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTradeLogEntry).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function isTradeLogEntry(v: unknown): v is TradeLogEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.ts === "number" &&
    typeof e.action === "string" &&
    typeof e.status === "string"
  );
}

function persist(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ring.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota / privacy mode — non-fatal, in-memory ring still works */
  }
}

/**
 * Append a structured entry. Emits JSON to console.info, pushes onto the capped
 * ring, persists to localStorage, and notifies subscribers.
 */
export function logTradeAction(entry: Omit<TradeLogEntry, "ts">): TradeLogEntry {
  const full: TradeLogEntry = { ts: Date.now(), ...entry };

  // Structured console line — easy to grep/filter in devtools or log capture.
  // eslint-disable-next-line no-console
  console.info(`[trade-log] ${JSON.stringify(full)}`);

  ring = [full, ...ring].slice(0, MAX_ENTRIES);
  persist();
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a bad subscriber shouldn't break logging */
    }
  }
  return full;
}

/** Read the current local action log (newest first). Safe during SSR (returns []). */
export function readTradeLog(): TradeLogEntry[] {
  return ring.slice();
}

/** Subscribe to log changes. Returns an unsubscribe fn. */
export function subscribeTradeLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Clear the local action log (in-memory + localStorage). */
export function clearTradeLog(): void {
  ring = [];
  persist();
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* noop */
    }
  }
}
