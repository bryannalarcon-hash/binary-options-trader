// market-select.test.ts — regression tests for pickMarketForStrike.
// Bug: trade page / order book / holdings resolved (ticker, strike) with a
// naive first-match `.find()`, so clicking today's live AAPL $320 showed the
// SETTLED May 27 AAPL $320 banner ("Resolved · No won … read-only").

import { expect } from "chai";

import { pickMarketForStrike } from "../../app/lib/market-select";

type M = {
  ticker: string;
  strike: number;
  expiryTs: number;
  settled: boolean;
  tag: string;
};

const mk = (
  ticker: string,
  strike: number,
  expiryTs: number,
  settled: boolean,
  tag: string,
): M => ({ ticker, strike, expiryTs, settled, tag });

describe("pickMarketForStrike", () => {
  it("prefers the live market over an older settled one at the same strike (the May-27 banner bug)", () => {
    // RPC ordering puts the OLD settled market first — `.find()` would return it.
    const markets = [
      mk("AAPL", 32000, 1779912000, true, "may27-settled"), // May 27, settled
      mk("AAPL", 32000, 1780689600, false, "today-live"), // today, live
    ];
    const picked = pickMarketForStrike(markets, "AAPL", 32000);
    expect(picked?.tag).to.equal("today-live");
  });

  it("prefers a non-settled awaiting-crank market over an older settled one", () => {
    const markets = [
      mk("TSLA", 41000, 1779912000, true, "settled"),
      mk("TSLA", 41000, 1780344000, false, "expired-unsettled"), // June 1 straggler
    ];
    expect(pickMarketForStrike(markets, "TSLA", 41000)?.tag).to.equal(
      "expired-unsettled",
    );
  });

  it("among non-settled duplicates, picks the latest expiry", () => {
    const markets = [
      mk("NVDA", 18000, 1780344000, false, "jun1"),
      mk("NVDA", 18000, 1780689600, false, "jun5"),
      mk("NVDA", 18000, 1779825600, false, "may26"),
    ];
    expect(pickMarketForStrike(markets, "NVDA", 18000)?.tag).to.equal("jun5");
  });

  it("falls back to the latest settled market when every match is settled", () => {
    const markets = [
      mk("MSFT", 50000, 1779566400, true, "may23"),
      mk("MSFT", 50000, 1779912000, true, "may27"),
    ];
    expect(pickMarketForStrike(markets, "MSFT", 50000)?.tag).to.equal("may27");
  });

  it("matches strike and ticker exactly; returns null when absent", () => {
    const markets = [
      mk("AAPL", 32000, 1780689600, false, "aapl"),
      mk("META", 32000, 1780689600, false, "meta-same-strike"),
    ];
    expect(pickMarketForStrike(markets, "META", 32000)?.tag).to.equal(
      "meta-same-strike",
    );
    expect(pickMarketForStrike(markets, "GOOGL", 32000)).to.equal(null);
    expect(pickMarketForStrike([], "AAPL", 32000)).to.equal(null);
  });
});
