import { expect } from "chai";

import { pickLatestSettledMarkets, latestSettledExpiry } from "../../app/lib/resolved-strikes";

type M = { strike: number; expiryTs: number; settled: boolean };

/**
 * Regression: the after-hours resolved view piled up EVERY past settled
 * expiry's strikes (3 days × 6 = up to 18 per ticker) because it de-duped by
 * strike value across all settled markets, and each day's ±3/6/9% grid has
 * different strike values. It must show only the MOST RECENT settled day's grid.
 */
describe("resolved strikes — latest settled expiry only", () => {
  // Three settled trading days, each a distinct 6-strike grid (values drift).
  const day1: M[] = [810, 840, 870, 930, 960, 990].map((s) => ({ strike: s, expiryTs: 100, settled: true }));
  const day2: M[] = [820, 850, 880, 940, 970, 1000].map((s) => ({ strike: s, expiryTs: 200, settled: true }));
  const day3: M[] = [830, 860, 890, 950, 980, 1010].map((s) => ({ strike: s, expiryTs: 300, settled: true }));
  const all = [...day1, ...day2, ...day3];

  it("returns ONLY the latest expiry's strikes (the bug: was returning all 18)", () => {
    const got = pickLatestSettledMarkets(all);
    expect(got).to.have.length(6);
    expect(got.every((m) => m.expiryTs === 300)).to.equal(true);
    expect(got.map((m) => m.strike).sort((a, b) => a - b)).to.deep.equal([
      830, 860, 890, 950, 980, 1010,
    ]);
  });

  it("latestSettledExpiry picks the max settled expiry", () => {
    expect(latestSettledExpiry(all)).to.equal(300);
    expect(latestSettledExpiry([])).to.equal(null);
  });

  it("ignores non-settled markets entirely", () => {
    const mixed: M[] = [
      ...day3,
      { strike: 999, expiryTs: 400, settled: false }, // future active — must be ignored
    ];
    const got = pickLatestSettledMarkets(mixed);
    expect(got).to.have.length(6);
    expect(got.some((m) => m.strike === 999)).to.equal(false);
  });

  it("de-dups by strike within the latest expiry (defensive)", () => {
    const dupes: M[] = [
      { strike: 830, expiryTs: 300, settled: true },
      { strike: 830, expiryTs: 300, settled: true },
      { strike: 860, expiryTs: 300, settled: true },
    ];
    expect(pickLatestSettledMarkets(dupes)).to.have.length(2);
  });

  it("returns [] when nothing is settled", () => {
    expect(pickLatestSettledMarkets([{ strike: 1, expiryTs: 1, settled: false }])).to.deep.equal([]);
  });
});
