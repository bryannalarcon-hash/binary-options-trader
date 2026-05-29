import assert from "node:assert/strict";
import test from "node:test";

import { oraclePriceToUsd, resolvePreviousCloseUsd } from "./morning-price";
import { fairMidCents, quote } from "./seed";

// Regression guard for the 2026-05-28/29 outage: Pyth Hermes returned HTTP 503,
// so the morning job got no previous-close price, skipped every ticker, created
// ZERO markets — and still reported the run "ok". The fix: fall back to the
// on-chain oracle price, and treat an all-null run as a failure (alert), not a
// silent success.

test("oraclePriceToUsd applies the Pyth expo (cents → dollars)", () => {
  assert.equal(oraclePriceToUsd(31146, -2), 311.46);
  assert.equal(oraclePriceToUsd(20000, -2), 200);
});

test("resolvePreviousCloseUsd falls back to the on-chain oracle when Hermes is missing", () => {
  // The actual outage: Hermes null → must use the oracle so markets still create.
  assert.equal(resolvePreviousCloseUsd(null, 311.46), 311.46);
  assert.equal(resolvePreviousCloseUsd(undefined, 311.46), 311.46);
  // Hermes present → prefer it (freshest "16h-ago close").
  assert.equal(resolvePreviousCloseUsd(250.5, 311.46), 250.5);
  // Neither usable → null (the run must NOT be reported as a healthy success).
  assert.equal(resolvePreviousCloseUsd(null, null), null);
  assert.equal(resolvePreviousCloseUsd(0, 0), null);
  assert.equal(resolvePreviousCloseUsd(-1, 311.46), 311.46);
  assert.equal(resolvePreviousCloseUsd(NaN, 311.46), 311.46);
});

test("fairMidCents is monotonic in spot vs strike and clamped to [1,99]", () => {
  assert.equal(fairMidCents(null, 30000), 50); // unknown spot → coin-flip
  assert.ok(fairMidCents(311.46, 30000) > 50); // spot above strike → Yes likely
  assert.ok(fairMidCents(311.46, 34000) < 50); // spot below strike → Yes unlikely
  const deep = fairMidCents(1000, 10000); // spot 10x strike → clamps, never > 99
  assert.ok(deep >= 1 && deep <= 99);
  const zero = fairMidCents(1, 100000); // spot far below → clamps, never < 1
  assert.ok(zero >= 1 && zero <= 99);
});

test("quote keeps 1 <= bid < ask <= 99 even at the extremes", () => {
  for (const mid of [1, 2, 50, 98, 99]) {
    const q = quote(mid, 6);
    assert.ok(q.bid >= 1 && q.ask <= 99, `bounds @${mid}: ${q.bid}/${q.ask}`);
    assert.ok(q.bid < q.ask, `bid<ask @${mid}: ${q.bid}/${q.ask}`);
  }
});
