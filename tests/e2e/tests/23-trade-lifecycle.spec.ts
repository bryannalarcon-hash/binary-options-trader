/**
 * 23-trade-lifecycle.spec.ts
 *
 * REAL on-chain trade lifecycle E2E (Solana localnet @ http://localhost:3000).
 *
 * Drives the in-app burner "Demo Wallet" (auto-funded ~1000 USDC) to exercise
 * the full market-maker / trader loop on the on-chain CLOB. NO mocks — every
 * action below produces a real signed transaction:
 *
 *   1. Place a limit order  → resting bid appears in MM "Active quotes".
 *   2. Cancel + refund      → order disappears, USDC balance restored.
 *   3. Mint a pair          → Quick Mint → Portfolio shows YES + NO holdings.
 *   4. Maker→taker fill      → context A posts an ask, context B crosses it.
 *
 * TICKER: TSLA ONLY (other swarms own AAPL/NVDA/etc.) to avoid order-book
 * collisions on the shared on-chain books.
 *
 * Selectors are derived from the real app source:
 *   - app/app/trade/[ticker]/[strike]/TradePageClient.tsx  (TradePanel)
 *   - app/app/portfolio/mm/page.tsx                         (MM dashboard)
 *   - app/app/portfolio/page.tsx                            (positions table)
 *   - app/lib/notify.ts (react-hot-toast)                   (success toasts)
 *
 * These are real txs: confirm + balance-refresh take time, so we use generous
 * timeouts (15-25s) and expect.poll for balances and on-chain reads.
 */

import { test, expect, type Page } from "@playwright/test";
import { headerUsdc } from "../fixtures/demo-wallet";

const TICKER = "TSLA";

/**
 * Robust connect to Demo Wallet `index`. Mirrors the shared helper but uses
 * `noWaitAfter` on the modal clicks: the burner select can schedule a benign
 * navigation/re-render that makes Playwright's auto-wait hang, which is the
 * dominant source of connect flakiness on this stack.
 */
async function connectDemo(page: Page, index: 1 | 2 = 1): Promise<void> {
  const header = page.locator("header");

  // Open the connect modal.
  await page
    .getByRole("button", { name: /Connect Wallet/i })
    .first()
    .click({ noWaitAfter: true });

  // The burner adapter occasionally emits a benign WalletConnectionError on the
  // first select→connect race; the modal stays open on failure, so retry the
  // selection a few times until the header flips to "Demo N".
  const burnerBtn = page
    .locator(`button:has-text("Demo Wallet ${index}")`)
    .first();

  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await header.innerText().catch(() => "")).includes(`Demo ${index}`)) break;
    if (await burnerBtn.isVisible().catch(() => false)) {
      await burnerBtn.click({ noWaitAfter: true });
    } else {
      // Modal closed (success path) — give the header a moment to render.
    }
    try {
      await expect(header).toContainText(`Demo ${index}`, { timeout: 8_000 });
      return;
    } catch {
      // Re-open the modal if it closed without connecting, then retry.
      if (!(await burnerBtn.isVisible().catch(() => false))) {
        await page
          .getByRole("button", { name: /Connect Wallet/i })
          .first()
          .click({ noWaitAfter: true })
          .catch(() => {});
      }
    }
  }

  await expect(header).toContainText(`Demo ${index}`, { timeout: 12_000 });
}

// react-hot-toast renders its messages in a fixed container; matching on the
// success copy from notify.ts is the most reliable confirm-signal we have.
function toast(page: Page, re: RegExp) {
  return page.getByText(re).first();
}

/**
 * Connect Demo Wallet `index` and fund it through the REAL in-app faucet UI.
 *
 * The shared `connectAndFund` helper assumes auto-fund-on-connect, but the app
 * does NOT auto-fund (see app/components/Header.tsx: "funding is MANUAL").
 * Funding is the "Fund demo wallet" button inside the "Demo N ⚙" panel, which
 * POSTs to the localnet automation faucet (NEXT_PUBLIC_FAUCET_URL) and airdrops
 * 2 SOL + mints 1000 test USDC on-chain.
 *
 * IMPORTANT — funding success is asserted via the "Topped up · 1000 USDC" toast,
 * NOT the header balance. On this build the header's `useUsdcBalance` read can
 * stay at $0.00 even though the burner truly holds 1000 USDC on-chain (verified
 * independently: getAccount on localhost:8899 returns 1000 for the connected
 * burner). The mint/order txs sign with the burner's real keypair and the chain
 * sees the real balance, so trades succeed regardless of the displayed number.
 *
 * If the faucet itself is unhealthy ("Top up failed: …"), we SKIP with that
 * exact reason rather than faking a pass.
 */
async function connectAndFundOrSkip(
  page: Page,
  index: 1 | 2 = 1,
): Promise<void> {
  await connectDemo(page, index);

  // The connect flow pops the WalletConnectModal (connected-state) over the UI.
  // Dismiss it so the header "Demo N ⚙" control is clickable.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // Open the Demo panel and click "Fund demo wallet".
  await page.getByRole("button", { name: new RegExp(`Demo ${index} ⚙`) }).first().click();
  await page.getByRole("button", { name: /Fund demo wallet/i }).click();

  // Faucet POST + airdrop + mint is slow; allow 45s. Success = "Topped up" toast.
  const okToast = toast(page, /Topped up/i);
  const failToast = toast(page, /Top up failed/i);
  await expect(okToast.or(failToast)).toBeVisible({ timeout: 45_000 });

  if (await failToast.isVisible().catch(() => false)) {
    const reason = await failToast.innerText().catch(() => "faucet failed");
    test.skip(true, `Localnet faucet unhealthy — ${reason}. Cannot fund burner; trade lifecycle requires USDC.`);
  }

  // Funded on-chain. Close the panel; give the mint a beat to confirm before we
  // sign trades against it.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(2_000);
}

/**
 * Navigate to /trade/TSLA, let the client redirect to the ATM strike, and
 * return the resolved strike (cents). We NEVER hardcode a strike — it comes
 * from the live on-chain strike chain so the test tracks whatever this localnet
 * actually has for TSLA.
 */
async function gotoTslaStrike(page: Page): Promise<number> {
  await page.goto(`/trade/${TICKER}`);
  // The [ticker] page client-redirects to /trade/TSLA/<strikeCents> once it has
  // real strikes + spot. Wait for that resolved URL.
  await page.waitForURL(new RegExp(`/trade/${TICKER}/\\d+`), { timeout: 30_000 });
  const m = page.url().match(new RegExp(`/trade/${TICKER}/(\\d+)`));
  expect(m, "expected a resolved TSLA strike in the URL").not.toBeNull();
  const strike = Number(m![1]);
  // Wait for the TradePanel to mount (the YES side card carries the strike copy).
  await expect(page.getByText(/YES · closes ≥/i)).toBeVisible({ timeout: 20_000 });
  return strike;
}

/**
 * If the first-3-trades ConfirmTradeModal is showing, click its "Confirm".
 * (TradePanel: settings.confirmTradeModal && tradesCompleted < 3 → modal.)
 */
async function confirmIfModal(page: Page) {
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  try {
    await confirm.waitFor({ state: "visible", timeout: 2_500 });
    await confirm.click();
  } catch {
    // No modal — settings disabled or already past 3 trades. Fine.
  }
}

/** Set Quantity in the right-rail trade panel. */
async function setQuantity(page: Page, qty: number) {
  // The first number input in the panel is "Quantity (tokens)".
  const qtyInput = page
    .locator("input[type='number']")
    .first();
  await qtyInput.fill(String(qty));
}

test.describe("Trade lifecycle (REAL on-chain)", () => {
  // On-chain confirms + balance refresh are slow; give each test room. Set per
  // test (beforeEach) so the budget covers connect+fund setup too.
  test.beforeEach(({}, testInfo) => {
    testInfo.setTimeout(150_000);
  });

  // -------------------------------------------------------------------------
  // 1. Place a limit order → it rests and appears on the MM dashboard.
  // -------------------------------------------------------------------------
  test("places a TSLA limit Buy-Yes → resting bid shows in MM Open Orders", async ({
    page,
  }) => {
    await page.goto("/");
    await connectAndFundOrSkip(page, 1);

    const strike = await gotoTslaStrike(page);

    // Switch to Limit. The order-type Seg has a "Limit" option.
    await page.getByRole("button", { name: /^Limit$/ }).click();

    // YES side is the default; make sure Buy is active.
    await page.getByRole("button", { name: /^Buy$/ }).click();

    // Limit price input appears only in limit mode ("Limit price (¢)").
    // Use a low bid (20¢) so it rests rather than crossing any resting ask.
    const limitInput = page.locator("input[type='number']").nth(1);
    await expect(limitInput).toBeVisible({ timeout: 10_000 });
    await limitInput.fill("20");

    await setQuantity(page, 10);

    // CTA: "Buy YES · $X". Click it, then clear any confirm modal.
    await page
      .getByRole("button", { name: /Buy YES ·/ })
      .click();
    await confirmIfModal(page);

    // Real tx confirm → the bid has no ask to cross on an empty book, so it
    // RESTS: success toast "Limit order placed · 10 YES resting @ 20¢".
    await expect(toast(page, /10\s+YES\s+resting/i)).toBeVisible({
      timeout: 25_000,
    });

    // Now the MM dashboard should list this resting bid.
    await page.goto("/portfolio/mm");
    // Wait for the wallet to reconnect + the open-orders scan to run.
    await expect(
      page.getByRole("heading", { name: /Market Maker/i }),
    ).toBeVisible({ timeout: 20_000 });

    // The Active-quotes table renders a row per resting order. Poll because the
    // on-chain orderbook scan runs on an interval after mount.
    const orderRow = page
      .locator("table.tbl tr")
      .filter({ hasText: TICKER })
      .filter({ hasText: /Bid/i })
      .filter({ hasText: "20¢" });
    await expect
      .poll(
        async () => {
          // nudge a refresh in case the periodic scan hasn't fired yet
          const refresh = page.getByRole("button", { name: /^Refresh$/ });
          if (await refresh.isVisible().catch(() => false)) {
            await refresh.click();
          }
          return orderRow.count();
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);

    await expect(orderRow.first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. Cancel that resting order → it disappears and USDC is refunded.
  // -------------------------------------------------------------------------
  test("cancels a resting TSLA bid → row disappears and USDC is refunded", async ({
    page,
  }) => {
    await page.goto("/");
    await connectAndFundOrSkip(page, 1);

    const strike = await gotoTslaStrike(page);

    // Post a fresh resting bid we fully control (price 18¢, qty 10 = $1.80 lock).
    await page.getByRole("button", { name: /^Limit$/ }).click();
    await page.getByRole("button", { name: /^Buy$/ }).click();
    const limitInput = page.locator("input[type='number']").nth(1);
    await limitInput.fill("18");
    await setQuantity(page, 10);

    const usdcBefore = await headerUsdc(page);

    await page.getByRole("button", { name: /Buy YES ·/ }).click();
    await confirmIfModal(page);
    // Empty book → the bid rests (immediate-or-cancel only applies to MARKET
    // orders): "Limit order placed · 10 YES resting @ 18¢".
    await expect(toast(page, /10\s+YES\s+resting/i)).toBeVisible({
      timeout: 25_000,
    });

    // USDC should have dropped by ~the locked notional ($1.80) after the bid.
    await expect
      .poll(() => headerUsdc(page), { timeout: 25_000, intervals: [1_500] })
      .toBeLessThan(usdcBefore);
    const usdcAfterOrder = await headerUsdc(page);

    // Go to MM, find our 18¢ bid row, cancel it.
    await page.goto("/portfolio/mm");
    await expect(
      page.getByRole("heading", { name: /Market Maker/i }),
    ).toBeVisible({ timeout: 20_000 });

    const ourRow = page
      .locator("table.tbl tr")
      .filter({ hasText: TICKER })
      .filter({ hasText: /Bid/i })
      .filter({ hasText: "18¢" });
    await expect
      .poll(
        async () => {
          const refresh = page.getByRole("button", { name: /^Refresh$/ });
          if (await refresh.isVisible().catch(() => false)) await refresh.click();
          return ourRow.count();
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);

    await ourRow.first().getByRole("button", { name: /^Cancel$/ }).click();

    // Cancel success toast: "Cancelled TSLA bid @ 18¢".
    await expect(toast(page, /Cancelled\s+TSLA\s+bid\s+@\s+18¢/i)).toBeVisible({
      timeout: 25_000,
    });

    // The 18¢ bid row disappears after the refresh fired by onCancelled.
    await expect
      .poll(
        async () => {
          const refresh = page.getByRole("button", { name: /^Refresh$/ });
          if (await refresh.isVisible().catch(() => false)) await refresh.click();
          return ourRow.count();
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBe(0);

    // USDC is restored toward the pre-cancel balance (refund of the locked bid).
    await expect
      .poll(() => headerUsdc(page), { timeout: 30_000, intervals: [2_000] })
      .toBeGreaterThan(usdcAfterOrder);
  });

  // -------------------------------------------------------------------------
  // 3. Mint a pair → Portfolio shows both YES and NO holdings.
  // -------------------------------------------------------------------------
  test("mints a TSLA pair via Quick Mint → Portfolio shows YES + NO holdings", async ({
    page,
  }) => {
    await page.goto("/");
    await connectAndFundOrSkip(page, 1);

    await page.goto("/portfolio/mm");
    await expect(
      page.getByRole("heading", { name: /Market Maker/i }),
    ).toBeVisible({ timeout: 20_000 });

    // Pick the TSLA option in the QuickMint select (the market select whose
    // options include a TSLA strike).
    const selects = page.locator("select");
    // Find the select whose options include a TSLA strike, and select it.
    const count = await selects.count();
    let mintSelect = selects.last();
    for (let i = count - 1; i >= 0; i--) {
      const s = selects.nth(i);
      const hasTsla = await s
        .locator("option", { hasText: TICKER })
        .count()
        .catch(() => 0);
      if (hasTsla > 0) {
        mintSelect = s;
        break;
      }
    }
    // Select the first TSLA option's value. (An <option> is never "visible" to
    // Playwright until the native dropdown is open, so read its value directly
    // rather than asserting visibility.)
    const tslaValue = await mintSelect
      .locator("option", { hasText: TICKER })
      .first()
      .getAttribute("value");
    expect(tslaValue, "expected a TSLA market option value").toBeTruthy();
    await mintSelect.selectOption(tslaValue!);

    // Pair count input is the number field immediately following the select.
    const pairInput = mintSelect.locator(
      "xpath=following::input[@type='number'][1]",
    );
    await pairInput.fill("5");

    // Click the "Mint N pair(s)" button.
    await page.getByRole("button", { name: /Mint\s+5\s+pairs?/i }).click();

    // Success toast: "Minted 5 pair(s) for $5.00.".
    await expect(toast(page, /Minted\s+5\s+pair/i)).toBeVisible({
      timeout: 25_000,
    });

    // Portfolio should now show BOTH a YES and a NO open position for TSLA.
    await page.goto("/portfolio");
    await expect(
      page.getByRole("heading", { name: /Portfolio/i }),
    ).toBeVisible({ timeout: 20_000 });

    // Open-positions table: rows have a TSLA contract cell + a side cell (YES/NO).
    // NOTE: the side cell renders lowercase "yes"/"no" (caps are CSS only). Table
    // cells concatenate WITHOUT spaces in textContent (e.g. "…todayyes5…"), so a
    // \byes\b word boundary never matches — use a case-insensitive substring.
    // For TSLA rows "yes"/"no" don't collide with other cell text.
    const tslaRows = page
      .locator("table.tbl tr")
      .filter({ hasText: TICKER });
    const yesRow = tslaRows.filter({ hasText: /yes/i });
    const noRow = tslaRows.filter({ hasText: /no/i });

    await expect
      .poll(
        async () => {
          const refresh = page.getByRole("button", { name: /^Refresh$/ });
          if (await refresh.isVisible().catch(() => false)) await refresh.click();
          return (await yesRow.count()) > 0 && (await noRow.count()) > 0;
        },
        { timeout: 50_000, intervals: [2_500] },
      )
      .toBe(true);

    await expect(yesRow.first()).toBeVisible();
    await expect(noRow.first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 4. Maker→taker fill (stretch): two independent burner contexts cross.
  //
  //    Context A (Demo 1): posts a limit ASK (Sell Yes) on a TSLA strike at P.
  //    Context B (Demo 2): places a Buy Yes that crosses P → a REAL fill.
  //    We then verify a trade lands in Recent Trades / 24h volume increments.
  //
  //    To post an ask you must hold YES tokens, so Context A mints a pair first
  //    (gives it YES inventory to sell). This is a genuine two-party on-chain
  //    match; if the localnet match path is flaky we keep it but document why
  //    rather than faking the assertion.
  // -------------------------------------------------------------------------
  test("maker→taker: Demo 2 buy crosses Demo 1 ask → real fill", async ({
    browser,
  }) => {
    // ----- Context A : maker (Demo Wallet 1) -----
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto("/");
    await connectAndFundOrSkip(pageA, 1);

    const strike = await gotoTslaStrike(pageA);

    // Maker needs YES inventory to sell → mint a few pairs on this strike.
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
    // Match exactly the strike we're going to trade on.
    const strikeLabel = `$${(strike / 100).toFixed(2)}`;
    const strikeOpt = mintSelectA
      .locator("option")
      .filter({ hasText: TICKER })
      .filter({ hasText: strikeLabel });
    const useOpt = (await strikeOpt.count()) > 0
      ? strikeOpt.first()
      : mintSelectA.locator("option", { hasText: TICKER }).first();
    const valA = await useOpt.getAttribute("value");
    await mintSelectA.selectOption(valA!);
    await mintSelectA
      .locator("xpath=following::input[@type='number'][1]")
      .fill("20");
    await pageA.getByRole("button", { name: /Mint\s+20\s+pairs?/i }).click();
    await expect(pageA.getByText(/Minted\s+20\s+pair/i).first()).toBeVisible({
      timeout: 25_000,
    });

    // Now post a limit ASK (Sell Yes) at a known price P on the trade page.
    const P = 60;
    await pageA.goto(`/trade/${TICKER}/${strike}`);
    await expect(pageA.getByText(/YES · closes ≥/i)).toBeVisible({ timeout: 20_000 });
    await pageA.getByRole("button", { name: /^Limit$/ }).click();
    await pageA.getByRole("button", { name: /^Sell$/ }).click();
    // limit price input is the 2nd number field
    await pageA.locator("input[type='number']").nth(1).fill(String(P));
    await pageA.locator("input[type='number']").first().fill("10"); // qty
    const sellCta = pageA.getByRole("button", { name: /Sell YES ·/ });
    await expect(sellCta).toBeVisible({ timeout: 10_000 });
    await sellCta.click();
    await confirmIfModal(pageA);
    // Maker's ask has no crossing bid yet → it RESTS: "…10 YES resting @ 60¢".
    await expect(pageA.getByText(/10\s+YES\s+resting/i).first()).toBeVisible({
      timeout: 25_000,
    });

    // ----- Context B : taker (Demo Wallet 2) -----
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto("/");
    await connectAndFundOrSkip(pageB, 2);
    await pageB.goto(`/trade/${TICKER}/${strike}`);
    await expect(pageB.getByText(/YES · closes ≥/i)).toBeVisible({ timeout: 20_000 });

    // Buy Yes as a LIMIT at >= P so it crosses the resting ask and fills.
    await pageB.getByRole("button", { name: /^Limit$/ }).click();
    await pageB.getByRole("button", { name: /^Buy$/ }).click();
    await pageB.locator("input[type='number']").nth(1).fill(String(P + 5)); // 65¢ ≥ 60¢ ask
    await pageB.locator("input[type='number']").first().fill("10");
    const buyCta = pageB.getByRole("button", { name: /Buy YES ·/ });
    await expect(buyCta).toBeVisible({ timeout: 10_000 });
    await buyCta.click();
    await confirmIfModal(pageB);
    await expect(pageB.getByText(/Bought\s+10\s+YES/i).first()).toBeVisible({
      timeout: 25_000,
    });

    // Verify a REAL fill landed: Recent Trades populates and/or 24h vol > 0.
    // Reload the trade page so the on-chain trade scan re-reads the book.
    await pageB.reload();
    await expect(pageB.getByText(/YES · closes ≥/i)).toBeVisible({ timeout: 20_000 });

    const recentTradesHasRow = async () => {
      // "Recent trades" table shows a row per OrderMatched fill at price P.
      const tradeCell = pageB
        .locator("table.tbl td")
        .filter({ hasText: `${P}¢` });
      return (await tradeCell.count()) > 0;
    };
    const vol24Positive = async () => {
      // Header strip "VOL 24H" cell value is the summed fill size.
      const volText = await pageB
        .locator("text=VOL 24H")
        .locator("xpath=..")
        .innerText()
        .catch(() => "");
      const m = volText.match(/([\d,]+)/);
      return m ? Number(m[1].replace(/,/g, "")) > 0 : false;
    };

    await expect
      .poll(
        async () => (await recentTradesHasRow()) || (await vol24Positive()),
        { timeout: 30_000, intervals: [3_000] },
      )
      .toBe(true);

    // Taker should now hold a YES position for TSLA.
    await pageB.goto("/portfolio");
    await expect(
      pageB.getByRole("heading", { name: /Portfolio/i }),
    ).toBeVisible({ timeout: 20_000 });
    const takerYes = pageB
      .locator("table.tbl tr")
      .filter({ hasText: TICKER })
      .filter({ hasText: /yes/i });
    await expect
      .poll(
        async () => {
          const refresh = pageB.getByRole("button", { name: /^Refresh$/ });
          if (await refresh.isVisible().catch(() => false)) await refresh.click();
          return takerYes.count();
        },
        { timeout: 50_000, intervals: [2_500] },
      )
      .toBeGreaterThan(0);

    await ctxA.close();
    await ctxB.close();
  });
});
