/**
 * 04-trade-buy-yes.spec.ts
 *
 * Trade page — Buy Yes happy path (PRD §2.10 Flow 1, IMPLEMENTATION_PLAN §16.3).
 *
 * Coverage:
 *   - Trade page renders: strike list (left), order book (center), trade panel (right)
 *   - "Buy Yes" button visible & enabled after wallet-connect
 *   - Entering quantity = 5 USDC populates the bet-preview (avg fill + payout)
 *   - Submitting triggers a wallet-sign request (mock auto-signs)
 *   - Success toast: "Trade confirmed" (or equivalent string)
 *   - YES balance appears in header / portfolio link (deferred to test 10)
 *
 * Pre-conditions (when the stack is fully wired):
 *   - At least one market exists for /trade/AAPL/22000 (run `make e2e-up`)
 *   - The trade panel uses the canonical TradePanel component (T-FE-05)
 *
 * Most assertions today are .fixme because the scaffolded trade page
 * (app/app/trade/[ticker]/[strike]/page.tsx) renders placeholders only.
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Trade — Buy Yes", () => {
  test("renders trade page layout: strikes, order book, trade panel", async ({ page }) => {
    await page.goto("/trade/AAPL");
    // Layout headings; ATM redirect → /trade/AAPL/0 in current scaffold.
    await expect(page.getByText(/AAPL/i)).toBeVisible();
    await expect(page.getByText(/Strikes|Strike/i)).toBeVisible();
    await expect(page.getByText(/Order book|Bids|Asks/i)).toBeVisible();
    await expect(page.getByText(/Trade|Connect to trade|Buy/i)).toBeVisible();
  });

  test.fixme("Buy Yes for 5 USDC → preview + sign + toast", async ({ page, mockWallet }) => {
    await page.goto("/trade/AAPL/22000");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // 1. Click "Buy Yes"
    await page.getByRole("button", { name: /Buy\s*Yes/i }).click();

    // 2. Enter 5 USDC
    const amountInput = page.locator("input[name='amount'], input[type='number']").first();
    await amountInput.fill("5");

    // 3. Bet preview shows avg fill + payout
    await expect(page.getByText(/avg fill|average price|payout/i)).toBeVisible();

    // 4. Submit
    await page.getByRole("button", { name: /Buy Yes for|Confirm|Submit/i }).click();

    // 5. Success toast
    await expect(
      page.getByText(/Trade confirmed|Order filled|Success/i),
    ).toBeVisible({ timeout: 15_000 });

    // 6. Yes balance reflected somewhere (header/portfolio link)
    await expect(
      page.locator("header, [data-testid='yes-balance']").filter({ hasText: /YES|5/ }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
