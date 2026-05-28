import { expect } from "chai";
import { shouldStopLoading, withTimeout } from "../../app/lib/loading-state";

/**
 * Regression for the after-hours "/portfolio loads infinitely" bug.
 *
 * Before the fix, `useUserPositions` (via `useAllMarkets`) could keep
 * `loading=true` forever when the first `market.all()` getProgramAccounts call
 * never settled under devnet RPC throttling — there was no timeout. These pure
 * helpers make the loading state terminal within a bounded time.
 */
describe("shouldStopLoading", () => {
  it("keeps loading while genuinely on the first load and markets still loading", () => {
    // marketsLoading, no error, first load, not timed out → keep spinning
    expect(shouldStopLoading(true, false, true, false)).to.equal(false);
  });

  it("stops once markets finish loading (real empty/data state)", () => {
    expect(shouldStopLoading(false, false, true, false)).to.equal(true);
  });

  it("stops on a markets read error", () => {
    expect(shouldStopLoading(true, true, true, false)).to.equal(true);
  });

  it("stops when the bounded timeout elapses even if markets still 'loading' (RPC hang)", () => {
    // This is the core bug: RPC never settles → marketsLoading stays true, but
    // the timeout must terminate the skeleton.
    expect(shouldStopLoading(true, false, true, true)).to.equal(true);
  });

  it("stops on a poll refresh (not the first load) regardless of markets loading", () => {
    expect(shouldStopLoading(true, false, false, false)).to.equal(true);
  });
});

describe("withTimeout", () => {
  it("resolves to the promise value when it settles in time", async () => {
    const fast = new Promise<number[]>((res) => setTimeout(() => res([1, 2, 3]), 5));
    const out = await withTimeout(fast, 100, []);
    expect(out).to.deep.equal([1, 2, 3]);
  });

  it("resolves to the fallback when the promise hangs past the timeout", async () => {
    // Never-resolving promise → must resolve to the fallback, not hang forever.
    const hang = new Promise<number[]>(() => {});
    const out = await withTimeout(hang, 20, []);
    expect(out).to.deep.equal([]);
  });

  it("resolves to the fallback when the promise rejects (no throw)", async () => {
    const rejecting = Promise.reject(new Error("rpc 429"));
    const out = await withTimeout(rejecting, 100, ["fallback"]);
    expect(out).to.deep.equal(["fallback"]);
  });
});
