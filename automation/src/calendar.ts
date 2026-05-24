import holidays from "./data/nyse-2026.json";

/**
 * NYSE trading-day calendar.
 *
 * v1 uses a hardcoded JSON for 2026 holidays. Production would consult a
 * proper data source (Polygon, NYSE iCal feed). Half-days are listed but treated
 * as full trading days for scheduling — only full closures skip the jobs.
 */

const HOLIDAY_SET = new Set<string>(holidays.holidays);

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

/** Day-of-week index in America/New_York: 0=Sun, 6=Sat. */
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

/** Returns true if `date` is a US equity-market trading day. */
export function isNyseTradingDay(date: Date = new Date()): boolean {
  const dow = nyDayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAY_SET.has(nyDateKey(date))) return false;
  return true;
}

/** Back-compat alias matching the prompt's requested API name. */
export const isMarketOpen = isNyseTradingDay;
