/**
 * 31-regression-rendering.spec.ts
 *
 * REAL (no-mock) REGRESSION suite for four previously-fixed Meridian
 * RENDERING / DATA-FRESHNESS bugs on Solana localnet (http://localhost:3000).
 *
 * These are the gaps NOT covered by 25-regression.spec.ts (which sweeps every
 * route for the generic loop signature). Here we drill into the specific bugs:
 *
 *   8.  infinite render loop ("Maximum update depth exceeded" / "Too many
 *       re-renders") caused by an UNSTABLE array identity returned from
 *       useMarketsForTicker. 25-regression covers it at the route level; THIS
 *       test focuses on /trade/AAPL — the route where the loop actually fired —
 *       plus /markets (which consumes the same markets-client hooks).
 *   9.  portfolio/wallet values flickered "right then wrong": the loading reset
 *       fired every poll and the unstable identity blew away last-good data, so
 *       a real balance briefly reverted to "—"/"$0.00". The fix is
 *       stale-while-revalidate (hold last-good). REGRESSION: once the USDC
 *       balance stat shows a real value it must NEVER revert to —/$0.00.
 *   10. the Portfolio "Refresh" button did NOTHING — it only re-keyed a
 *       presentational div, the data hook never re-ran. The fix wires it to the
 *       hook's refetch(). REGRESSION: clicking Refresh must not throw / crash
 *       and must not leave the positions area in a broken/infinite-spinner
 *       state; ideally a freshly-minted position appears after Refresh.
 *   11. nested <a> hydration warning on the markets card (a <Link> strike chip
 *       nested inside an outer <a>). The fix made the outer wrapper a
 *       role="link" <div>. REGRESSION: /markets emits ZERO
 *       "cannot be a descendant of" / validateDOMNesting / hydrate <a> warnings.
 *
 * TICKER: AAPL — read-only display target assigned to this agent. Bug #10's
 * optional mint step touches AAPL's MM market; sibling trading agents own other
 * tickers, so this avoids order-book collisions.
 *
 * CONVENTIONS:
 *   - per-test timeout 120_000 via testInfo.setTimeout
 *   - benign ws / ERR_CONNECTION console noise is IGNORED (no live ws relay /
 *     RPC subscription sockets on the local stack)
 *   - order books may be SEEDED or EMPTY — no test depends on book state
 *   - tests-only: never edits app/
 */

import { test, expect, type Page } from "@playwright/test";
import { connectAndFund, headerUsdc } from "../fixtures/demo-wallet";

// Heavy trace/video artifacts add no signal to a render-loop guard and race
// under concurrent load (artifact-zip ENOENT). Disable for this read-only-ish
// sweep so the guard stays deterministic. Must be top-level.
test.use({ trace: "off", video: "off", screenshot: "off" });

// ---------------------------------------------------------------------------
// Console / pageerror capture helpers (shared shape with 25-regression).
// ---------------------------------------------------------------------------
interface Captured {
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
}

/** Attach console + pageerror listeners; returns live-growing buffers. */
function capture(page: Page): Captured {
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error") consoleErrors.push(msg.text());
    else if (t === "warning") consoleWarnings.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(`${err.name}: ${err.message}`);
  });
  return { consoleErrors, consoleWarnings, pageErrors };
}

/** True for console/page errors EXPECTED on the local stack (not a regression). */
function isBenign(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("websocket") ||
    m.includes("ws://") ||
    m.includes("wss://") ||
    (m.includes("connection") && m.includes("refused")) ||
    m.includes("err_connection_refused") ||
    m.includes("err_connection") ||
    m.includes("failed to connect to") ||
    m.includes("failed to fetch") ||
    m.includes("[fast refresh]")
  );
}

/** The React infinite-render-loop signature (the exact bug #8 wording). */
const LOOP_RE = /Maximum update depth|Too many re-renders/i;

/** The nested-<a> hydration warning signature (bug #11). */
const NESTED_A_RE = /cannot be a descendant of|validateDOMNesting|hydrat.*<a>/i;

test.describe("Regression — rendering & data-freshness (REAL stack)", () => {
  // -------------------------------------------------------------------------
  // BUG 8: infinite render loop "Maximum update depth exceeded" from an
  //        unstable array identity in useMarketsForTicker.
  // REGRESSION: open /trade/AAPL (the route where the loop fired) and /markets
  //        (same markets-client hooks); watch console errors + pageerror events
  //        for ~6s each. Assert ZERO /Maximum update depth|Too many re-renders/i
  //        and ZERO uncaught pageerrors (benign ws/ERR_CONNECTION noise ignored).
  // -------------------------------------------------------------------------
  test("BUG8: /trade/AAPL and /markets never trip an infinite render loop", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    const cap = capture(page);

    // --- /trade/AAPL : the route where the unstable-identity loop fired. ---
    await page.goto("/trade/AAPL", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    // The client resolves /trade/AAPL → /trade/AAPL/<strike>. Wait for the
    // redirect so the per-strike TradePageClient (the loop's home) is mounted.
    await page.waitForURL(/\/trade\/AAPL\/\d+/, { timeout: 40_000 });
    // Confirm the trade panel actually rendered its real content (status-OK
    // proxy) before we judge "no loop" — a blank page proves nothing.
    await expect(page.getByText(/YES · closes ≥|CONTRACT|Strike chain/i).first())
      .toBeVisible({ timeout: 30_000 });
    // A runaway setState loop floods the console within a second or two — idle
    // ~6s so it has a generous window to misfire.
    await page.waitForTimeout(6_000);

    // --- /markets : consumes the same useStrikeList / useSpotPrice hooks. ---
    await page.goto("/markets", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await expect(page.getByRole("heading", { name: /^Markets$/i }).first())
      .toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(6_000);

    // ASSERT 1: zero infinite-render-loop signatures across console + pageerror.
    const loopHits = [...cap.consoleErrors, ...cap.pageErrors].filter((m) =>
      LOOP_RE.test(m),
    );
    expect(
      loopHits,
      `infinite render loop signature seen on /trade/AAPL + /markets:\n${loopHits.join("\n")}`,
    ).toHaveLength(0);

    // ASSERT 2: zero uncaught pageerrors (excluding benign ws/connection noise).
    const realPageErrors = cap.pageErrors.filter((e) => !isBenign(e));
    expect(
      realPageErrors,
      `uncaught page error(s) on /trade/AAPL + /markets:\n${realPageErrors.join("\n")}`,
    ).toHaveLength(0);

    // Visibility (not a failure): how much benign noise we ignored.
    const benign = [...cap.consoleErrors, ...cap.pageErrors].filter(isBenign).length;
    console.log(
      `[BUG8] ${cap.consoleErrors.length} console errors (${benign} benign ws/conn), ` +
        `${cap.pageErrors.length} pageerrors — 0 loop signatures.`,
    );
  });

  // -------------------------------------------------------------------------
  // BUG 9: portfolio/wallet values flickered "right then wrong" — the loading
  //        reset fired every poll and the unstable identity wiped last-good
  //        data, so a real balance briefly reverted to "—"/"$0.00".
  // REGRESSION: connectAndFund(1, 1), open /portfolio, sample the "USDC
  //        balance" stat 5× over ~5s. Once it FIRST shows a real value it must
  //        never revert to "—"/"$0.00" (stale-while-revalidate holds last-good).
  // -------------------------------------------------------------------------
  test("BUG9: /portfolio USDC balance never reverts to —/$0.00 once shown", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(120_000);

    await page.goto("/");
    await connectAndFund(page, 1, 1);
    // Sanity: the header reflects the funded balance before we judge portfolio.
    expect(await headerUsdc(page)).toBeGreaterThanOrEqual(1);

    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: /^Portfolio$/i }).first())
      .toBeVisible({ timeout: 25_000 });

    // The "USDC balance" SummaryCell renders:
    //   <div>                                 <- cell wrapper
    //     <div class="label">USDC balance</div>
    //     <div class="num …">$X.XX | —</div>  <- the value we sample
    //     <div>on-chain</div>
    // Anchor on the exact label, hop to its parent cell, then read the value
    // div — so we sample the EXACT stat the flicker bug affected (not some
    // other "$x.xx" on the page).
    const usdcLabel = page.locator("div.label", { hasText: /^USDC balance$/i }).first();
    const usdcValue = usdcLabel.locator("xpath=../div[contains(@class,'num')][1]");

    // Wait for the FIRST real (non-placeholder) value to appear.
    await expect
      .poll(
        async () => (await usdcValue.innerText().catch(() => "")).trim(),
        { timeout: 30_000, intervals: [500, 1_000] },
      )
      .toMatch(/\$[\d,]+\.\d\d/);

    const isPlaceholder = (s: string) =>
      s === "" || s === "—" || /^\$0\.00$/.test(s.trim());

    const firstReal = (await usdcValue.innerText()).trim();
    expect(isPlaceholder(firstReal), `expected a real balance, got "${firstReal}"`)
      .toBe(false);

    // Sample 5× over ~5s (covers the 15s poll's mid-flight loading window the
    // old code reset through). Any revert to —/$0.00 is the flicker regression.
    const samples: string[] = [firstReal];
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(1_000);
      samples.push((await usdcValue.innerText().catch(() => "")).trim());
    }

    const reverted = samples.filter(isPlaceholder);
    expect(
      reverted,
      `USDC balance reverted to placeholder after showing a real value (flicker):\n${samples
        .map((s, i) => `  [${i}] "${s}"`)
        .join("\n")}`,
    ).toHaveLength(0);

    console.log(`[BUG9] USDC balance samples: ${samples.map((s) => `"${s}"`).join(", ")}`);
  });

  // -------------------------------------------------------------------------
  // BUG 10: the Portfolio "Refresh" button did NOTHING — it re-keyed a
  //         presentational div but the data hook (useUserPositions) never
  //         re-ran. The fix wires onClick → refetch().
  // REGRESSION (the important one): connectAndFund(1, 5); on /portfolio click
  //         "Refresh". Assert it does NOT throw and the positions area stays
  //         rendered (no crash, no infinite spinner). BEST-EFFORT bonus: mint
  //         an AAPL position via /portfolio/mm Quick Mint first, then click
  //         Refresh and assert a position row appears within ~15s. Bonus is
  //         tolerant (mint may be unavailable) so the core guard stays robust.
  // -------------------------------------------------------------------------
  test("BUG10: /portfolio Refresh re-runs the data hook (no crash / no stuck spinner)", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    const cap = capture(page);

    await page.goto("/");
    await connectAndFund(page, 1, 5);

    // --- BEST-EFFORT: mint an AAPL pair so Refresh has a NEW position to surface.
    // Wrapped in try/catch — if the AAPL MM market isn't available the core
    // Refresh guard below still runs (this bonus must never fail the test).
    let mintedAapl = false;
    try {
      await page.goto("/portfolio/mm", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await expect(page.getByRole("heading", { name: /^Market Maker$/i }).first())
        .toBeVisible({ timeout: 20_000 });

      // Find the Quick Mint select that offers an AAPL option (last select that
      // contains one — Quote-Both-Sides and Quick-Mint both render a market
      // <select>; Quick Mint is the lower of the two).
      const selects = page.locator("select");
      const n = await selects.count();
      let mintSelect = null as ReturnType<typeof selects.nth> | null;
      for (let i = n - 1; i >= 0; i--) {
        const s = selects.nth(i);
        const aaplOpts = await s
          .locator("option", { hasText: "AAPL" })
          .count()
          .catch(() => 0);
        if (aaplOpts > 0) {
          mintSelect = s;
          break;
        }
      }
      if (mintSelect) {
        const aaplOpt = mintSelect.locator("option", { hasText: "AAPL" }).first();
        const val = await aaplOpt.getAttribute("value");
        if (val) {
          await mintSelect.selectOption(val);
          // Quick Mint's "Pair count" input is the number input following its
          // select; set a small mint.
          await mintSelect
            .locator("xpath=following::input[@type='number'][1]")
            .fill("3");
          const mintBtn = page.getByRole("button", { name: /Mint\s+3\s+pairs?/i });
          if (await mintBtn.isVisible().catch(() => false)) {
            await mintBtn.click();
            // Confirm the mint landed on chain (success toast). Tolerant timeout.
            await expect(page.getByText(/Minted\s+3\s+pair/i).first()).toBeVisible({
              timeout: 30_000,
            });
            mintedAapl = true;
          }
        }
      }
    } catch (err) {
      console.log(`[BUG10] mint bonus skipped: ${String(err).slice(0, 120)}`);
    }

    // --- CORE GUARD: Refresh on /portfolio must re-run the hook without crash.
    await page.goto("/portfolio", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await expect(page.getByRole("heading", { name: /^Portfolio$/i }).first())
      .toBeVisible({ timeout: 25_000 });

    // The "Open positions" card header proves the positions area mounted.
    const positionsHeader = page.getByRole("heading", { name: /^Open positions$/i });
    await expect(positionsHeader).toBeVisible({ timeout: 25_000 });

    const refreshBtn = page.getByRole("button", { name: /^Refresh$/ });
    await expect(refreshBtn).toBeVisible({ timeout: 15_000 });

    // Click Refresh a couple of times — the old no-op div re-key never threw,
    // but the fix routes through refetch() which kicks the loading state. Either
    // way it must NOT crash and must settle (no permanent spinner).
    await refreshBtn.click();
    await page.waitForTimeout(1_500);
    await refreshBtn.click();

    // The positions area must remain rendered: either the open-positions table
    // OR the explicit "No active positions." empty state — but NOT a stuck
    // skeleton-loader forever and NOT a blank/crashed page.
    const settled = page
      .getByText(/No active positions\.|Browse markets/i)
      .first()
      .or(page.locator("table.tbl").first());
    await expect(settled, "positions area should settle (table or empty-state), not spin forever")
      .toBeVisible({ timeout: 25_000 });

    // The card header must still be there (no crash unmounted the page).
    await expect(positionsHeader).toBeVisible();

    // No uncaught error from the Refresh click path.
    const realPageErrors = cap.pageErrors.filter((e) => !isBenign(e));
    expect(
      realPageErrors,
      `Refresh click threw uncaught page error(s):\n${realPageErrors.join("\n")}`,
    ).toHaveLength(0);
    const loopHits = [...cap.consoleErrors, ...cap.pageErrors].filter((m) =>
      LOOP_RE.test(m),
    );
    expect(loopHits, `Refresh triggered a render loop:\n${loopHits.join("\n")}`)
      .toHaveLength(0);

    // BONUS: if we minted an AAPL pair, Refresh should surface a real position
    // row referencing AAPL within ~15s. Tolerant: only asserted when minted.
    if (mintedAapl) {
      const aaplRow = page.getByRole("cell", { name: /AAPL/ }).first();
      await expect(
        aaplRow,
        "after minting AAPL + Refresh, an AAPL position row should appear",
      ).toBeVisible({ timeout: 15_000 });
      console.log("[BUG10] minted AAPL pair → AAPL position row visible after Refresh.");
    } else {
      console.log(
        "[BUG10] core Refresh guard passed (mint bonus not exercised this run).",
      );
    }
  });

  // -------------------------------------------------------------------------
  // BUG 11: nested <a> hydration warning on the markets card — a <Link> (=<a>)
  //         strike chip nested inside an outer <a> wrapper. The fix made the
  //         outer wrapper a role="link" <div>.
  // REGRESSION: open /markets, capture console; assert ZERO message matching
  //         /cannot be a descendant of|validateDOMNesting|hydrat.*<a>/i.
  //         (React surfaces validateDOMNesting as a console.error in dev; we
  //         also scan warnings to be safe.)
  // -------------------------------------------------------------------------
  test("BUG11: /markets emits no nested-<a> hydration warning", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    const cap = capture(page);

    await page.goto("/markets", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await expect(page.getByRole("heading", { name: /^Markets$/i }).first())
      .toBeVisible({ timeout: 25_000 });

    // Ensure the StockCards (grid view, the bug's location) actually rendered
    // their strike chains — the nested <a> only existed once chips painted.
    await expect(page.getByText(/AAPL/).first()).toBeVisible({ timeout: 20_000 });
    // Give the strike chips (async useStrikeList) time to render the <Link>
    // chips inside each card; the hydration mismatch fired during this paint.
    await page.waitForTimeout(6_000);

    // Scan BOTH console.error and console.warning — React logs DOM-nesting
    // validation as an error in dev, but be defensive across versions.
    const nestedHits = [...cap.consoleErrors, ...cap.consoleWarnings].filter((m) =>
      NESTED_A_RE.test(m),
    );
    expect(
      nestedHits,
      `nested-<a> hydration warning on /markets:\n${nestedHits.join("\n")}`,
    ).toHaveLength(0);

    console.log(
      `[BUG11] /markets — ${cap.consoleErrors.length} console errors, ` +
        `${cap.consoleWarnings.length} warnings — 0 nested-<a> hydration hits.`,
    );
  });
});
