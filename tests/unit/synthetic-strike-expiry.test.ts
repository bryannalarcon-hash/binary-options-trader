import { expect } from "chai";

import {
  expiryTsForDate,
  isTradingDay,
  nextTradingDayExpiryTs,
} from "../../app/lib/market-hours";

/** Format a unix-seconds instant in America/New_York for assertions. */
function etParts(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: Number(get("hour") === "24" ? "0" : get("hour")),
    minute: Number(get("minute")),
    date: d,
  };
}

/**
 * Regression: admin-created synthetic strikes must expire on a FUTURE trading
 * day at the 4:00 PM ET close so they're tradeable past the 0DTE close — not at
 * today's already-passed expiry.
 */
describe("synthetic-strike expiry (nextTradingDayExpiryTs)", () => {
  it("lands on a future 4:00 PM ET close on a real trading day", () => {
    // A normal Wednesday (2026-06-10 12:00 ET ≈ 16:00 UTC).
    const now = new Date(Date.UTC(2026, 5, 10, 16, 0, 0));
    const ts = nextTradingDayExpiryTs(now);
    expect(ts * 1000).to.be.greaterThan(now.getTime());
    const p = etParts(ts);
    expect(p.hour).to.equal(16);
    expect(p.minute).to.equal(0);
    expect(isTradingDay(p.date)).to.equal(true);
    // Next trading day after Wed = Thu.
    expect(p.weekday).to.equal("Thu");
  });

  it("skips the weekend (Friday → Monday)", () => {
    // Friday 2026-06-12.
    const fri = new Date(Date.UTC(2026, 5, 12, 16, 0, 0));
    const ts = nextTradingDayExpiryTs(fri);
    const p = etParts(ts);
    expect(p.weekday).to.equal("Mon");
    expect(p.hour).to.equal(16);
    expect(isTradingDay(p.date)).to.equal(true);
  });

  it("expiryTsForDate yields 16:00 ET for a given day", () => {
    const ts = expiryTsForDate(new Date(Date.UTC(2026, 5, 10, 0, 0, 0)));
    const p = etParts(ts);
    expect(p.hour).to.equal(16);
    expect(p.minute).to.equal(0);
  });
});
