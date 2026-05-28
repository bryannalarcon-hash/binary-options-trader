/**
 * Pure (React-free) helpers for making a "loading" state TERMINAL.
 *
 * Bug: a positions / markets read can stay `loading=true` forever if the
 * underlying `getProgramAccounts` RPC never settles (devnet throttling) — there
 * was no timeout, so the UI showed an infinite skeleton. These helpers let a
 * hook decide, deterministically, when loading must stop even if the RPC hangs.
 *
 * Kept dependency-free so they're unit-testable under mocha (no React/Next).
 */

/**
 * Decide whether a derived "positions/strikes" loading state should STOP.
 *
 * @param marketsLoading  Is the upstream markets read still in flight?
 * @param marketsError    Did the upstream markets read error out?
 * @param isFirstLoad     Are we still in the very first load (vs a poll refresh)?
 * @param timedOut        Has the bounded loading timeout elapsed?
 * @returns true when loading must resolve to a terminal (empty/error) state.
 *
 * Loading should keep spinning ONLY while the upstream markets read is genuinely
 * still loading AND it's the first load AND the timeout hasn't elapsed and there
 * was no error. Any of: not-first-load, an error, or an elapsed timeout makes
 * the state terminal — so the UI resolves to real data / "empty" / "error"
 * instead of an infinite skeleton.
 */
export function shouldStopLoading(
  marketsLoading: boolean,
  marketsError: boolean,
  isFirstLoad: boolean,
  timedOut: boolean,
): boolean {
  if (marketsError) return true;
  if (timedOut) return true;
  if (!isFirstLoad) return true;
  return !marketsLoading;
}

/**
 * Race a promise against a bounded timeout. Resolves to the promise's value if
 * it settles in time, otherwise resolves to `timeoutValue` (NEVER rejects on
 * timeout, and never leaves a dangling timer once either side wins).
 *
 * Used to wrap `market.all()` so a hung `getProgramAccounts` resolves to an
 * honest empty/error state within `ms` instead of pinning loading=true forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutValue: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(timeoutValue);
      },
    );
  });
}
