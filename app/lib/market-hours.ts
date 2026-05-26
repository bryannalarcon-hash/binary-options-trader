/**
 * US equity market-hours helper (America/New_York).
 *
 * Mirrors the NYSE trading-day logic in `automation/src/calendar.ts`
 * (holiday list ported from `automation/src/data/nyse-2026.json`) and adds
 * intraday session detection so the UI can show an accurate market-status
 * indicator instead of a perpetual "LIVE" dot.
 *
 * All computation is done in America/New_York regardless of the viewer's
 * local timezone. Because the result depends on the current wall-clock time,
 * call sites must gate rendering behind `useMounted()` to avoid SSR/hydration
 * mismatches.
 */

/** Regular session: 09:30–16:00 ET. */
const OPEN_MIN = 9 * 60 + 30; // 570
const CLOSE_MIN = 16 * 60; // 960
/** Pre-market: 04:00–09:30 ET. */
const PRE_MIN = 4 * 60; // 240
/** After-hours: 16:00–20:00 ET. */
const POST_MIN = 20 * 60; // 1200

/**
 * NYSE full-closure holidays for 2026 (YYYY-MM-DD, ET).
 * Ported from `automation/src/data/nyse-2026.json`.
 */
export const NYSE_HOLIDAYS_2026: readonly string[] = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
];

/**
 * NYSE early-close (1:00 PM ET) half-days for 2026.
 * On these days regular session ends at 13:00 ET instead of 16:00.
 */
export const NYSE_HALF_DAYS_2026: readonly string[] = [
  "2026-07-02",
  "2026-11-27",
  "2026-12-24",
];

const HOLIDAY_SET = new Set<string>(NYSE_HOLIDAYS_2026);
const HALF_DAY_SET = new Set<string>(NYSE_HALF_DAYS_2026);

export type MarketStatus = "open" | "closed" | "pre" | "post";

/** Format a date as YYYY-MM-DD in America/New_York. */
export function nyDateKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

/** Day-of-week index in America/New_York: 0=Sun … 6=Sat. */
function nyDayOfWeek(date: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? 0;
}

/** Minutes since midnight in America/New_York. */
function nyMinutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  // Intl can emit "24" for midnight in some runtimes; normalize to 0.
  const hour = h === 24 ? 0 : h;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Returns true if `date` is a US equity-market trading day (weekday, not a holiday). */
export function isTradingDay(date: Date = new Date()): boolean {
  const dow = nyDayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAY_SET.has(nyDateKey(date))) return false;
  return true;
}

/**
 * Returns the current US equity-market session for `date` (America/New_York):
 *   - "open":   trading day, 09:30–16:00 ET (13:00 on half-days)
 *   - "pre":    trading day, 04:00–09:30 ET
 *   - "post":   trading day, regular-close–20:00 ET
 *   - "closed": nights, weekends, holidays
 */
export function marketStatus(date: Date = new Date()): MarketStatus {
  if (!isTradingDay(date)) return "closed";

  const mins = nyMinutesOfDay(date);
  const closeMin = HALF_DAY_SET.has(nyDateKey(date)) ? 13 * 60 : CLOSE_MIN;

  if (mins >= OPEN_MIN && mins < closeMin) return "open";
  if (mins >= PRE_MIN && mins < OPEN_MIN) return "pre";
  if (mins >= closeMin && mins < POST_MIN) return "post";
  return "closed";
}

/** Presentation metadata for a given market status. */
export interface MarketStatusDisplay {
  /** Short label for the indicator chip. */
  label: string;
  /** CSS class controlling dot + text color. */
  chipClass: string;
  /** Whether the dot should pulse (only when live). */
  live: boolean;
}

export function marketStatusDisplay(status: MarketStatus): MarketStatusDisplay {
  switch (status) {
    case "open":
      return { label: "LIVE", chipClass: "chip-status chip-status--open", live: true };
    case "pre":
      return { label: "PRE-MKT", chipClass: "chip-status chip-status--pre", live: false };
    case "post":
      return { label: "AFTER HRS", chipClass: "chip-status chip-status--post", live: false };
    case "closed":
    default:
      return { label: "CLOSED", chipClass: "chip-status chip-status--closed", live: false };
  }
}
