// test-tickers.test.ts — unit tests for the TEST-market ticker helpers.
// A TEST market's on-chain ticker ends in "-T" (e.g. "AAPL-T"): a permanently-
// tradeable fixture mirroring a real stock. The helpers must detect it, strip
// the suffix, and produce a display name that clearly labels it "(Test)".

import { expect } from "chai";

import {
  TEST_TICKER_SUFFIX,
  baseTicker,
  displayTickerName,
  isTestTicker,
} from "../../app/lib/tickers";

describe("TEST-market ticker helpers", () => {
  it("exposes the on-chain TEST suffix", () => {
    expect(TEST_TICKER_SUFFIX).to.equal("-T");
  });

  describe("isTestTicker", () => {
    it("detects '-T' suffixed tickers", () => {
      expect(isTestTicker("AAPL-T")).to.equal(true);
      expect(isTestTicker("NVDA-T")).to.equal(true);
    });

    it("rejects real tickers, including ones that merely end in 'T'", () => {
      expect(isTestTicker("AAPL")).to.equal(false);
      expect(isTestTicker("MSFT")).to.equal(false); // ends in "T", not "-T"
      expect(isTestTicker("META")).to.equal(false);
    });

    it("rejects degenerate inputs", () => {
      expect(isTestTicker("")).to.equal(false);
      expect(isTestTicker("-T")).to.equal(false); // suffix alone is no ticker
    });
  });

  describe("baseTicker", () => {
    it("strips the '-T' suffix from a test ticker", () => {
      expect(baseTicker("AAPL-T")).to.equal("AAPL");
      expect(baseTicker("TSLA-T")).to.equal("TSLA");
    });

    it("is a no-op for non-test tickers", () => {
      expect(baseTicker("AAPL")).to.equal("AAPL");
      expect(baseTicker("MSFT")).to.equal("MSFT");
      expect(baseTicker("")).to.equal("");
    });
  });

  describe("displayTickerName", () => {
    it("labels a known test ticker with the mirrored name + ' (Test)'", () => {
      expect(displayTickerName("AAPL-T")).to.equal("Apple (Test)");
      expect(displayTickerName("NVDA-T")).to.equal("NVIDIA (Test)");
    });

    it("passes real tickers through to their company name", () => {
      expect(displayTickerName("AAPL")).to.equal("Apple");
      expect(displayTickerName("META")).to.equal("Meta Platforms");
    });

    it("falls back to the raw ticker when unknown", () => {
      expect(displayTickerName("ZZZZ")).to.equal("ZZZZ");
    });

    it("still labels an unknown test ticker as '(Test)'", () => {
      expect(displayTickerName("ZZZZ-T")).to.equal("ZZZZ (Test)");
    });
  });
});
