import { expect } from "chai";

import { expectedStrikeCents, canonicalStrikeSet } from "../../app/lib/strike-grid";

/**
 * Regression for the ">6 strikes" bug (MSFT showed 9 on devnet). Markets are
 * permanent on-chain PDAs; if a ticker's strikes get re-created at a drifted
 * reference price, off-grid duplicates accumulate (MSFT: 400/430/470 on top of
 * the canonical 410/420/440/460/480/490). The strike list must collapse to the
 * canonical ±3/6/9% ladder when (and ONLY when) more strikes exist than the grid
 * expects — a no-op in normal operation (exactly 6 strikes/ticker/day).
 */

describe("strike-grid", () => {
  it("expectedStrikeCents reproduces the ±3/6/9% $10-rounded ladder", () => {
    // MSFT spot ~$449.99 -> the canonical 6.
    expect(expectedStrikeCents(44999)).to.deep.equal([
      41000, 42000, 44000, 46000, 48000, 49000,
    ]);
  });

  it("collapses an over-full strike set to the canonical grid (the MSFT bug)", () => {
    const onChain = [40000, 41000, 42000, 43000, 44000, 46000, 47000, 48000, 49000]; // 9
    const keep = canonicalStrikeSet(onChain, 44999);
    expect(keep).to.not.equal(null);
    expect([...keep!].sort((a, b) => a - b)).to.deep.equal([
      41000, 42000, 44000, 46000, 48000, 49000,
    ]); // 6 canonical; 40000/43000/47000 dropped
  });

  it("is a no-op when the count is already within the grid", () => {
    // Exactly the canonical 6 -> don't filter (returns null = keep all).
    expect(canonicalStrikeSet([41000, 42000, 44000, 46000, 48000, 49000], 44999)).to.equal(null);
    // Fewer than 6 (rounding/dedup) -> also keep all.
    expect(canonicalStrikeSet([19000, 20000, 21000, 22000, 23000], 21175)).to.equal(null);
  });

  it("does not filter when the reference price is unknown", () => {
    expect(canonicalStrikeSet([40000, 41000, 42000, 43000, 44000, 46000, 47000], null)).to.equal(null);
  });
});
