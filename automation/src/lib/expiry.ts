/**
 * Expiry / time helpers.
 *
 * Markets expire at 4:00 PM America/New_York (NYSE close). On localnet with
 * TEST_BYPASS_TIME_GATE=true the contract ignores the time gate, but the
 * automation still picks 4 PM ET as the canonical expiry so on-chain state
 * stays representative of production.
 */

const NY_TZ = "America/New_York";

/**
 * Returns the unix timestamp (seconds) of today's 4:00 PM in America/New_York.
 *
 * Implementation: format `now` in NY tz using Intl.DateTimeFormat, parse the
 * resulting Y/M/D, then construct a UTC date for 4 PM NY by walking the local
 * offset (NY is UTC-5 in EST, UTC-4 in EDT).
 *
 * Edge case: if it's already past 4 PM NY, we still return today's 4 PM —
 * callers that want "next 4 PM" should adjust upstream.
 */
export function todayExpiryTsSeconds(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);

  // Find the UTC offset for NY at this moment to compute UTC of "today 16:00 NY".
  // We do this by formatting the current UTC time as NY and computing the diff.
  const nyTimeAsUtcMillis = Date.UTC(year, month - 1, day, 16, 0, 0); // pretend NY is UTC for now
  const offsetMinutes = nyOffsetMinutes(now);
  return Math.floor((nyTimeAsUtcMillis - offsetMinutes * 60_000) / 1000);
}

/** Returns NY's UTC offset in minutes at `date` (negative; EST=-300, EDT=-240). */
function nyOffsetMinutes(date: Date): number {
  // Format `date` as NY time and parse it back into a UTC instant; diff gives offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    map.year,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    map.hour === 24 ? 0 : map.hour ?? 0,
    map.minute ?? 0,
    map.second ?? 0,
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}
