/**
 * 30-regression-trading.spec.ts
 *
 * REAL on-chain REGRESSION suite for four previously-fixed Meridian trading
 * bugs (Solana localnet @ http://localhost:3000). NO mocks — every assertion
 * drives the live UI and confirms a real signed transaction / on-chain result.
 *
 * TICKER: GOOGL ONLY — sibling agents own other MAG7 tickers; using a private
 * ticker keeps our resting orders from colliding on the shared on-chain books.
 *
 * Because the book may be SEEDED or EMPTY depending on stack state, every test
 * CREATES the on-chain state it needs (posts its own order, or uses a two-party
 * maker→taker cross across distinct browser contexts) rather than assuming a
 * global empty/seeded book.
 *
 * The four bugs under test (one `test(...)` each, cited inline):
 *   1. "fee_destination_usdc not provided" — composite-tx never passed the fee
 *      account → trades reverted. REGRESSION: a placed order succeeds with NO
 *      fee/not-provided/revert error toast.
 *   2. self-trade NotOrderOwner (0x1782) — Buy-NO crossed your OWN resting YES
 *      order. REGRESSION: with a resting YES bid, Buy NO does NOT throw
 *      NotOrderOwner (routes via mint_pair) — success toast OR constraint modal.
 *   3. MARKET on EMPTY book silently rested a 99¢ bid (fixed to IOC). The empty
 *      case lives in 27-empty-book-pricing.spec.ts; here we add the COMPLEMENT:
 *      with real liquidity, a market order FILLS ("Bought N YES").
 *   4. trade toast was inaccurate ("Bought 10 YES" for an unfilled resting
 *      limit). REGRESSION: a resting limit shows "…N YES resting @ X¢" (NOT
 *      "Bought"); a crossing order shows "Bought N YES".
 *
 * Selectors mirror the real source:
 *   - app/app/trade/[ticker]/[strike]/TradePageClient.tsx (TradePanel toasts)
 *   - app/lib/notify.ts (react-hot-toast copy)
 *   - app/components/PositionConstraintModal.tsx ("Close opposite position first")
 */

import { test, expect, type Page } from "@playwright/test";
import { connectAndFund } from "../fixtures/demo-wallet";

const TICKER = "GOOGL";

// react-hot-toast renders messages in a fixed container; matching on the exact
// success/error copy from notify.ts is the most reliable confirm signal.
function toast(page: Page, re: RegExp) {
  return page.getByText(re).first();
}

// Any error-shaped toast the buggy paths used to surface. notify.error renders
// the message "Trade failed: <err>"; the regressed errors contained these.
const ERROR_TOAST_RE =
  /Trade failed|fee_destination|not provided|reverted|custom program error|NotOrderOwner|0x1782/i;

/**
 * Navigate to /trade/GOOGL, let the client redirect to the resolved ATM strike,
 * and return that strike (cents). Never hardcode a strike — read it from the
 * live on-chain strike chain so the test tracks whatever this localnet has.
 */
async function gotoGooglStrike(page: Page): Promise<number> {
  await page.goto(`/trade/${TICKER}`);
  await page.waitForURL(new RegExp(`/trade/${TICKER}/\\d+`), { timeout: 30_000 });
  const m = page.url().match(new RegExp(`/trade/${TICKER}/(\\d+)`));
  expect(m, "expected a resolved GOOGL strike in the URL").not.toBeNull();
  await expect(page.getByText(/YES · closes ≥/i).first()).toBeVisible({ timeout: 30_000 });
  return Number(m![1]);
}

/** Open Trade panel directly on a known strike and wait for it to mount. */
async function gotoStrikePage(page: Page, strike: number): Promise<void> {
  await page.goto(`/trade/${TICKER}/${strike}`);
  await expect(page.getByText(/YES · closes ≥/i).first()).toBeVisible({ timeout: 30_000 });
}

/** Set the Quantity field (first number input in the trade panel). */
async function setQuantity(page: Page, qty: number) {
  await page.locator("input[type='number']").first().fill(String(qty));
}

/**
 * Set the Limit price field (2nd number input — visible only in Limit mode).
 * Ensures Limit mode is active first; the order-type Seg click can be dropped
 * by a concurrent book-load re-render, so retry until the input appears.
 */
async function setLimitPrice(page: Page, cents: number) {
  const limitBtn = page.getByRole("button", { name: /^Limit$/ });
  const limitInput = page.locator("input[type='number']").nth(1);
  await expect
    .poll(
      async () => {
        if (await limitInput.isVisible().catch(() => false)) return true;
        if (await limitBtn.isVisible().catch(() => false)) {
          await limitBtn.click().catch(() => {});
        }
        return limitInput.isVisible().catch(() => false);
      },
      { timeout: 15_000, intervals: [500, 1_000] },
    )
    .toBe(true);
  await limitInput.fill(String(cents));
}

/**
 * Clear the first-3-trades ConfirmTradeModal if it shows
 * (TradePanel: settings.confirmTradeModal && tradesCompleted < 3 → modal).
 */
async function confirmIfModal(page: Page) {
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  try {
    await confirm.waitFor({ state: "visible", timeout: 2_500 });
    await confirm.click();
  } catch {
    // No modal — fine.
  }
}

/**
 * Assert NO error toast appears within `ms`. We wait the window out (the buggy
 * paths surfaced a sticky `notify.error` toast quickly), then assert the error
 * locator never became visible.
 */
async function expectNoErrorToast(page: Page, ms = 6_000) {
  const errToast = page.getByText(ERROR_TOAST_RE).first();
  await page.waitForTimeout(ms);
  await expect(errToast).toHaveCount(0);
}

test.describe("Regression: trading bugs (REAL on-chain)", () => {
  // On-chain confirms + balance refresh are slow; give each test plenty of room.
  test.beforeEach(({}, testInfo) => {
    testInfo.setTimeout(150_000);
  });

  // -------------------------------------------------------------------------
  // BUG 1: trades reverted with "fee_destination_usdc not provided" because the
  //        composite-tx never passed the fee account into place_order.
  // REGRESSION: a placed order (here a resting limit bid) succeeds with NO
  //        "fee"/"not provided"/revert error toast — assert the success toast
  //        appears and no error toast appears.
  // -------------------------------------------------------------------------
  test("BUG1: order succeeds with no fee_destination_usdc revert", async ({ page }) => {
    await page.goto("/");
    await connectAndFund(page, 1, 1);

    const strike = await gotoGooglStrike(page);
    await gotoStrikePage(page, strike);

    // Place a LIMIT Buy-YES at a deep bid (12¢) so it rests rather than crossing
    // any seeded ask — a resting place_order STILL exercises the fee-account
    // wiring (buildPlaceOrderIx passes feeDestinationUsdc), so this is a valid
    // regression for the missing-fee-account revert.
    await page.getByRole("button", { name: /^Limit$/ }).click();
    await page.getByRole("button", { name: /^Buy$/ }).click();
    await setLimitPrice(page, 12);
    await setQuantity(page, 10);

    await page.getByRole("button", { name: /Buy YES ·/ }).click();
    await confirmIfModal(page);

    // SUCCESS path: any react-hot-toast success (resting OR a fill) is fine —
    // both prove the fee account was supplied and the tx did NOT revert.
    const successToast = toast(page, /(YES\s+resting|Bought\s+\d+\s+YES)/i);
    await expect(successToast).toBeVisible({ timeout: 30_000 });

    // CRITICAL regression assertion: no fee/not-provided/revert error toast.
    await expect(page.getByText(ERROR_TOAST_RE).first()).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // BUG 2: self-trade NotOrderOwner (0x1782) — buying the opposite side crossed
  //        your OWN resting order.
  // REGRESSION: with ONE demo wallet, place a resting YES bid (limit), then
  //        attempt to Buy NO. It must NOT fail with NotOrderOwner — the app
  //        routes Buy-NO via mint_pair, not by crossing your own YES order.
  //        Acceptable outcomes: a success toast OR the position-constraint modal.
  // -------------------------------------------------------------------------
  test("BUG2: Buy NO over own resting YES bid does not self-trade (0x1782)", async ({
    page,
  }) => {
    await page.goto("/");
    await connectAndFund(page, 1, 1);

    const strike = await gotoGooglStrike(page);
    await gotoStrikePage(page, strike);

    // Step 1 — post a resting YES bid we own (limit Buy YES @ 55¢). High enough
    // that, if Buy-NO ever tried to cross the YES book as an ask at (100-NO),
    // it would hit THIS bid and trip NotOrderOwner under the old bug.
    await page.getByRole("button", { name: /^Limit$/ }).click();
    await page.getByRole("button", { name: /^Buy$/ }).click();
    await setLimitPrice(page, 55);
    await setQuantity(page, 10);
    await page.getByRole("button", { name: /Buy YES ·/ }).click();
    await confirmIfModal(page);
    // The bid either rests or (against a seeded ask) fills — either is fine; we
    // just need a confirmed order on chain. Tolerate both toast shapes.
    await expect(
      toast(page, /(YES\s+resting|Bought\s+\d+\s+YES)/i),
    ).toBeVisible({ timeout: 30_000 });

    // Step 2 — now attempt Buy NO on the SAME strike. The fixed router uses
    // mint_pair (+ sell-YES skipping our own order via excludeOwner), so this
    // must NOT throw NotOrderOwner / 0x1782.
    await page.getByRole("button", { name: /^NO · closes/i }).click();
    await page.getByRole("button", { name: /^Buy$/ }).click();
    // Use a LIMIT Buy-NO (deterministic across seeded/empty books): the Buy-NO
    // composite is mint_pair(qty) + sell-YES @ (100 - noLimit) = sell-YES @ 55¢,
    // which under the OLD bug would cross our OWN 55¢ YES bid → NotOrderOwner.
    // The fix skips our own order, so this completes.
    await page.getByRole("button", { name: /^Limit$/ }).click();
    await setLimitPrice(page, 45); // NO @ 45¢ → sell-YES leg @ 55¢ (== our own bid)
    await setQuantity(page, 5);
    const buyNo = page.getByRole("button", { name: /Buy NO ·/ });
    await expect(buyNo).toBeVisible({ timeout: 10_000 });
    await buyNo.click();
    await confirmIfModal(page);

    // ACCEPTABLE: a success toast (Bought/resting NO) OR the position-constraint
    // modal ("Close opposite position first") — both mean we did NOT self-trade.
    const okToast = toast(page, /(Bought\s+\d+\s+NO|NO\s+resting|Minted)/i);
    const constraintModal = page.getByText(/Close opposite position first/i).first();
    await expect(okToast.or(constraintModal)).toBeVisible({ timeout: 35_000 });

    // CRITICAL regression assertion: NO NotOrderOwner / 0x1782 error toast.
    await expect(
      page.getByText(/NotOrderOwner|0x1782/i).first(),
    ).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // BUG 3: a MARKET order on an EMPTY book silently rested a bid at the 99¢ cap;
  //        fixed to be immediate-or-cancel. The EMPTY case is covered by
  //        27-empty-book-pricing.spec.ts. COMPLEMENT here: when there IS
  //        liquidity, a MARKET order FILLS.
  // We create liquidity ourselves: Demo 1 posts a limit ASK (Sell YES @ 60¢),
  // then Demo 2 (separate browser context) places a MARKET Buy YES → real fill
  // toast "Bought N YES" (NOT "No liquidity"). Two contexts avoid the self-trade
  // guard (maker and taker are different on-chain owners).
  // -------------------------------------------------------------------------
  test("BUG3: MARKET order FILLS against real liquidity (not IOC-cancelled)", async ({
    browser,
  }) => {
    // ----- Context A : maker (Demo Wallet 1) — posts a resting ASK -----
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      await pageA.goto("/");
      await connectAndFund(pageA, 1, 1);
      const strike = await gotoGooglStrike(pageA);

      // To post an ASK (Sell YES) the maker needs YES inventory → mint a pair
      // on the MM dashboard for this strike first.
      await pageA.goto("/portfolio/mm");
      await expect(
        pageA.getByRole("heading", { name: /Market Maker/i }),
      ).toBeVisible({ timeout: 20_000 });

      const selectsA = pageA.locator("select");
      const cA = await selectsA.count();
      let mintSelectA = selectsA.last();
      for (let i = cA - 1; i >= 0; i--) {
        const s = selectsA.nth(i);
        const opt = await s.locator("option", { hasText: TICKER }).count().catch(() => 0);
        if (opt > 0) {
          mintSelectA = s;
          break;
        }
      }
      const strikeLabel = `$${(strike / 100).toFixed(2)}`;
      const strikeOpt = mintSelectA
        .locator("option")
        .filter({ hasText: TICKER })
        .filter({ hasText: strikeLabel });
      const useOpt =
        (await strikeOpt.count()) > 0
          ? strikeOpt.first()
          : mintSelectA.locator("option", { hasText: TICKER }).first();
      const valA = await useOpt.getAttribute("value");
      expect(valA, "expected a GOOGL market option to mint against").toBeTruthy();
      await mintSelectA.selectOption(valA!);
      await mintSelectA
        .locator("xpath=following::input[@type='number'][1]")
        .fill("20");
      await pageA.getByRole("button", { name: /Mint\s+20\s+pairs?/i }).click();
      await expect(pageA.getByText(/Minted\s+20\s+pair/i).first()).toBeVisible({
        timeout: 30_000,
      });

      // Post a limit ASK (Sell YES @ 60¢) on the trade page — this is the
      // liquidity the taker's MARKET buy will cross.
      const P = 60;
      await gotoStrikePage(pageA, strike);
      await pageA.getByRole("button", { name: /^Limit$/ }).click();
      await pageA.getByRole("button", { name: /^Sell$/ }).click();
      await setLimitPrice(pageA, P);
      await setQuantity(pageA, 10);
      await pageA.getByRole("button", { name: /Sell YES ·/ }).click();
      await confirmIfModal(pageA);
      // No crossing bid yet → the ask RESTS: "…10 YES resting @ 60¢".
      await expect(pageA.getByText(/10\s+YES\s+resting/i).first()).toBeVisible({
        timeout: 30_000,
      });

      // ----- Context B : taker (Demo Wallet 2) — MARKET Buy YES -----
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      try {
        await pageB.goto("/");
        await connectAndFund(pageB, 2, 1);
        await gotoStrikePage(pageB, strike);

        // Default order type is Market. With Demo 1's ask resting, the book is
        // NOT empty → the CTA should be a real "Buy YES" (not the empty-book
        // "No liquidity — switch to Limit" steer). Assert we don't get steered.
        await pageB.getByRole("button", { name: /^Buy$/ }).click();
        await setQuantity(pageB, 10);

        const steer = pageB.getByRole("button", {
          name: /No liquidity — switch to Limit/i,
        });
        // Give the book a moment to load so the empty-book steer (if any)
        // resolves to the real CTA; poll for the executable Buy button.
        const buyCta = pageB.getByRole("button", { name: /Buy YES ·/ });
        await expect
          .poll(
            async () => {
              if (await buyCta.isVisible().catch(() => false)) return "buy";
              if (await steer.isVisible().catch(() => false)) return "steer";
              return "none";
            },
            { timeout: 25_000, intervals: [1_500] },
          )
          .toBe("buy");

        await buyCta.click();
        await confirmIfModal(pageB);

        // REGRESSION: a MARKET buy against real liquidity FILLS → "Bought N YES".
        // It must NOT surface the IOC "No liquidity" error.
        await expect(pageB.getByText(/Bought\s+\d+\s+YES/i).first()).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          pageB.getByText(/No liquidity to buy YES at market/i),
        ).toHaveCount(0);
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });

  // -------------------------------------------------------------------------
  // BUG 4: trade toast was inaccurate ("Bought 10 YES" even for an UNFILLED
  //        resting limit order).
  // REGRESSION: a limit order that RESTS (no cross) shows a "…N YES resting @
  //        X¢" toast (/N\s+YES\s+resting/i), NOT "Bought". A crossing order
  //        shows "Bought N YES". We assert both arms via a real maker→taker
  //        cross across two contexts.
  // -------------------------------------------------------------------------
  test("BUG4: resting limit toast says 'resting' (not 'Bought'); cross says 'Bought'", async ({
    browser,
  }) => {
    // ----- Maker (Demo 1): a resting limit Buy-YES @ 14¢ → 'resting' toast -----
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      await pageA.goto("/");
      await connectAndFund(pageA, 1, 1);
      const strike = await gotoGooglStrike(pageA);
      await gotoStrikePage(pageA, strike);

      const RESTING_QTY = 10;
      const RESTING_PX = 14; // deep bid → rests (won't cross typical seeded asks)
      await pageA.getByRole("button", { name: /^Limit$/ }).click();
      await pageA.getByRole("button", { name: /^Buy$/ }).click();
      await setLimitPrice(pageA, RESTING_PX);
      await setQuantity(pageA, RESTING_QTY);
      await pageA.getByRole("button", { name: /Buy YES ·/ }).click();
      await confirmIfModal(pageA);

      // ASSERT the accurate resting toast, and that it is NOT "Bought".
      await expect(
        pageA.getByText(new RegExp(`${RESTING_QTY}\\s+YES\\s+resting`, "i")).first(),
      ).toBeVisible({ timeout: 30_000 });
      // The buggy build would have shown "Bought 10 YES" for this unfilled order.
      await expect(pageA.getByText(/Bought\s+\d+\s+YES/i)).toHaveCount(0);

      // ----- Crossing arm: a maker posts an ASK, a taker BUYS it → "Bought N YES"
      // To make the cross deterministic we use Demo 1 (maker) to post a sellable
      // ASK (needs YES inventory → mint), then Demo 2 (taker) buys it. The cross
      // path must emit "Bought N YES".
      await pageA.goto("/portfolio/mm");
      await expect(
        pageA.getByRole("heading", { name: /Market Maker/i }),
      ).toBeVisible({ timeout: 20_000 });
      const selectsA = pageA.locator("select");
      const cA = await selectsA.count();
      let mintSelectA = selectsA.last();
      for (let i = cA - 1; i >= 0; i--) {
        const s = selectsA.nth(i);
        const opt = await s.locator("option", { hasText: TICKER }).count().catch(() => 0);
        if (opt > 0) {
          mintSelectA = s;
          break;
        }
      }
      const strikeLabel = `$${(strike / 100).toFixed(2)}`;
      const strikeOpt = mintSelectA
        .locator("option")
        .filter({ hasText: TICKER })
        .filter({ hasText: strikeLabel });
      const useOpt =
        (await strikeOpt.count()) > 0
          ? strikeOpt.first()
          : mintSelectA.locator("option", { hasText: TICKER }).first();
      const valA = await useOpt.getAttribute("value");
      await mintSelectA.selectOption(valA!);
      await mintSelectA
        .locator("xpath=following::input[@type='number'][1]")
        .fill("15");
      await pageA.getByRole("button", { name: /Mint\s+15\s+pairs?/i }).click();
      await expect(pageA.getByText(/Minted\s+15\s+pair/i).first()).toBeVisible({
        timeout: 30_000,
      });

      const ASK_PX = 62;
      await gotoStrikePage(pageA, strike);
      await pageA.getByRole("button", { name: /^Limit$/ }).click();
      await pageA.getByRole("button", { name: /^Sell$/ }).click();
      await setLimitPrice(pageA, ASK_PX);
      await setQuantity(pageA, 10);
      await pageA.getByRole("button", { name: /Sell YES ·/ }).click();
      await confirmIfModal(pageA);
      await expect(pageA.getByText(/10\s+YES\s+resting/i).first()).toBeVisible({
        timeout: 30_000,
      });

      // ----- Taker (Demo 2): a limit Buy-YES @ >= ASK_PX crosses → "Bought N YES"
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      try {
        await pageB.goto("/");
        await connectAndFund(pageB, 2, 1);
        await gotoStrikePage(pageB, strike);

        await pageB.getByRole("button", { name: /^Limit$/ }).click();
        await pageB.getByRole("button", { name: /^Buy$/ }).click();
        await setLimitPrice(pageB, ASK_PX + 5); // 67¢ ≥ 62¢ ask → crosses
        await setQuantity(pageB, 10);
        await pageB.getByRole("button", { name: /Buy YES ·/ }).click();
        await confirmIfModal(pageB);

        // ASSERT the accurate crossing toast: "Bought N YES".
        await expect(pageB.getByText(/Bought\s+\d+\s+YES/i).first()).toBeVisible({
          timeout: 30_000,
        });
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });
});
