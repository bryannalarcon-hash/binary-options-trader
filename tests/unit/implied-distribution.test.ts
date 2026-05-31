import { expect } from "chai";

import { computeImpliedDistribution } from "../../app/lib/implied-distribution";

/**
 * Regression for the landing market-odds hero's distribution curve. The hero
 * derives a risk-neutral PDF from the live strike chain via Breeden-Litzenberger
 * (Yes price = P(S_T >= K)). This locks the math so a future refactor can't
 * silently break the implied mean / ±1σ range the hero renders, or reintroduce
 * negative densities from a non-monotonic (noisy) chain.
 */

describe("implied-distribution", () => {
  it("returns null with fewer than two strikes", () => {
    expect(computeImpliedDistribution([])).to.equal(null);
    expect(computeImpliedDistribution([{ strike: 12000, yes: 50 }])).to.equal(null);
  });

  it("derives the implied mean as the probability-weighted center", () => {
    // Symmetric chain centered on $120: Yes prices fall 90→10 linearly.
    const d = computeImpliedDistribution([
      { strike: 10000, yes: 90 },
      { strike: 11000, yes: 70 },
      { strike: 12000, yes: 50 },
      { strike: 13000, yes: 30 },
      { strike: 14000, yes: 10 },
    ]);
    expect(d).to.not.equal(null);
    expect(d!.bars).to.have.length(4); // one bar per adjacent pair
    expect(d!.minK).to.equal(10000);
    expect(d!.maxK).to.equal(14000);
    expect(d!.mean).to.equal(12000); // symmetric → center
    expect(d!.std).to.be.closeTo(1118, 1); // sqrt(1.25M cents²)
  });

  it("clips a non-monotonic chain so no density goes negative", () => {
    // Yes price RISES at one strike (noise / a crossed book); BL must clip it.
    const d = computeImpliedDistribution([
      { strike: 10000, yes: 60 },
      { strike: 11000, yes: 75 }, // bogus: higher Yes at a higher strike
      { strike: 12000, yes: 40 },
    ]);
    expect(d).to.not.equal(null);
    for (const b of d!.bars) {
      expect(b.density).to.be.at.least(0);
      expect(b.prob).to.be.at.least(0);
    }
    // Mean and ±1σ band stay inside the observed strike range.
    expect(d!.mean).to.be.within(d!.minK, d!.maxK);
    expect(d!.std).to.be.at.least(0);
  });

  it("sorts an unordered chain before taking slopes", () => {
    const d = computeImpliedDistribution([
      { strike: 13000, yes: 30 },
      { strike: 10000, yes: 90 },
      { strike: 12000, yes: 50 },
      { strike: 11000, yes: 70 },
    ]);
    expect(d).to.not.equal(null);
    expect(d!.minK).to.equal(10000);
    expect(d!.maxK).to.equal(13000);
    expect(d!.mean).to.be.within(10000, 13000);
  });
});
