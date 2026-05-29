import { expect } from "chai";

import { planRedeemAmount } from "../../app/lib/redeem-plan";

/**
 * Regression for the redeem NotEnoughBalance (0x177e) bug: redeem must never
 * request more than the wallet actually holds. The amount is clamped to the
 * live balance; 0 means "skip this market" rather than send a doomed tx.
 */
describe("planRedeemAmount", () => {
  it("redeems the full quantity when fully held", () => {
    expect(planRedeemAmount(10, 10)).to.equal(10);
  });
  it("clamps to the held balance when the cached quantity is stale/too high", () => {
    expect(planRedeemAmount(10, 4)).to.equal(4);
  });
  it("returns 0 (skip) when nothing is held — was the source of NotEnoughBalance", () => {
    expect(planRedeemAmount(10, 0)).to.equal(0);
  });
  it("returns 0 for non-positive / non-finite requests", () => {
    expect(planRedeemAmount(0, 10)).to.equal(0);
    expect(planRedeemAmount(-5, 10)).to.equal(0);
    expect(planRedeemAmount(NaN, 10)).to.equal(0);
    expect(planRedeemAmount(10, NaN)).to.equal(0);
  });
  it("floors fractional inputs", () => {
    expect(planRedeemAmount(10.9, 7.9)).to.equal(7);
  });
});
