import { expect } from "chai";

import { buildPositions } from "../../app/lib/positions-build";

// Minimal Market-shaped object (only the fields buildPositions reads).
function mkt(over: Partial<any> = {}): any {
  return {
    address: "M1",
    ticker: "AAPL",
    strike: 22000,
    yesMint: "YES1",
    noMint: "NO1",
    settled: false,
    outcome: null,
    ...over,
  };
}

/**
 * Regression for the batched-balances rewrite of useUserPositions (the
 * after-hours infinite-load fix): assembly must split active/settled correctly,
 * never fetch/assign a live mid to a settled market, and skip zero balances.
 */
describe("buildPositions", () => {
  it("assigns an ACTIVE held position with the book mid as currentPrice", () => {
    const markets = [mkt({ address: "A", yesMint: "YA", noMint: "NA" })];
    const balances = new Map([["YA", 10]]);
    const basis = new Map([["A|yes", { avgCents: 60 }]]);
    const mids = new Map<string, number | null>([["A", 55]]);
    const { active, settled } = buildPositions(markets, balances, basis, mids);
    expect(settled).to.have.length(0);
    expect(active).to.have.length(1);
    expect(active[0]).to.include({ side: "yes", quantity: 10, entryPrice: 60, currentPrice: 55 });
  });

  it("a SETTLED held position is settled with currentPrice null (never a mid)", () => {
    const markets = [mkt({ address: "S", yesMint: "YS", noMint: "NS", settled: true, outcome: "yes" })];
    const balances = new Map([["NS", 7]]);
    const basis = new Map<string, { avgCents: number }>();
    // Even if a mid were somehow present, settled must ignore it.
    const mids = new Map<string, number | null>([["S", 42]]);
    const { active, settled } = buildPositions(markets, balances, basis, mids);
    expect(active).to.have.length(0);
    expect(settled).to.have.length(1);
    expect(settled[0]).to.include({ side: "no", quantity: 7, currentPrice: null });
    expect(settled[0]!.entryPrice).to.equal(null); // no basis → null, not invented
  });

  it("skips markets with zero balance on both sides", () => {
    const markets = [mkt({ address: "Z", yesMint: "YZ", noMint: "NZ" })];
    const { active, settled } = buildPositions(markets, new Map([["YZ", 0]]), new Map(), new Map());
    expect(active).to.have.length(0);
    expect(settled).to.have.length(0);
  });

  it("emits both legs when the user holds YES and NO", () => {
    const markets = [mkt({ address: "B", yesMint: "YB", noMint: "NB" })];
    const balances = new Map([["YB", 3], ["NB", 4]]);
    const mids = new Map<string, number | null>([["B", 50]]);
    const { active } = buildPositions(markets, balances, new Map(), mids);
    expect(active.map((p) => p.side).sort()).to.deep.equal(["no", "yes"]);
  });
});
