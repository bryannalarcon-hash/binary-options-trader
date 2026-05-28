import { expect } from "chai";
import { pickRedirectStrike } from "../../app/lib/trade-redirect";

/**
 * Regression for the after-hours "/trade/[ticker]" hang.
 *
 * Before the fix, the page only ever considered ACTIVE (non-settled) strikes
 * and `return`ed early when there were none — so after the 4 PM ET close (all
 * of today's 0DTE markets settled), `rows.length === 0` meant the redirect
 * effect never fired and the page spun on "Loading markets…" forever.
 *
 * `pickRedirectStrike` makes the decision terminal: settled strikes still yield
 * a target (so the market opens read-only), and only a genuinely empty chain
 * (no active AND no settled) returns null → caller routes to /markets.
 */
describe("pickRedirectStrike", () => {
  it("returns the ATM ACTIVE strike when active strikes exist", () => {
    const active = [21000, 22000, 23000];
    const settled = [19000, 20000];
    // spot 21900 → closest active is 22000
    expect(pickRedirectStrike(active, settled, 21900)).to.equal(22000);
  });

  it("prefers active over settled even when a settled strike is closer to spot", () => {
    const active = [22000];
    const settled = [21950]; // numerically closer to spot, but settled
    expect(pickRedirectStrike(active, settled, 21900)).to.equal(22000);
  });

  it("returns the ATM SETTLED strike when active is empty but settled exist (after-hours bug)", () => {
    const active: number[] = [];
    const settled = [20000, 21000, 22000];
    // spot 21100 → closest settled is 21000; must NOT return null (no hang)
    expect(pickRedirectStrike(active, settled, 21100)).to.equal(21000);
  });

  it("falls back to the first strike when spot is unknown", () => {
    expect(pickRedirectStrike([23000, 21000, 22000], [], null)).to.equal(23000);
    expect(pickRedirectStrike([], [20000, 19000], null)).to.equal(20000);
  });

  it("returns null only when BOTH active and settled are empty", () => {
    expect(pickRedirectStrike([], [], 21000)).to.equal(null);
    expect(pickRedirectStrike([], [], null)).to.equal(null);
  });
});
