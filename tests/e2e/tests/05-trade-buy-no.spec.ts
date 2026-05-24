/**
 * 05-trade-buy-no.spec.ts
 *
 * Trade page — Buy No (composite mint+sell-Yes), single signature.
 * PRD §2.10 Flow 2, IMPLEMENTATION_PLAN §5.5 Flow 2, §16.3 F-FE-TR-16.
 *
 * Coverage:
 *   - "Buy No" is a first-class button (not buried in a menu)
 *   - Clicking it builds the atomic mint_pair + place-Yes-ask composite tx
 *   - Wallet receives ONE signature request (verified via mock callback count)
 *   - On success, NO balance appears in portfolio link / header chip
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Trade — Buy No (composite mint+sell)", () => {
  test("Buy No button is visible as a primary action", async ({ page }) => {
    await page.goto("/trade/AAPL/22000");
    // Stub today: this text may not be present until T-FE-05 lands.
    test.fixme(true, "Buy No first-class button — depends on T-FE-05 TradePanel");
    await expect(page.getByRole("button", { name: /Buy\s*No/i })).toBeVisible();
  });

  test.fixme("Buy No happy path → one signature, NO balance appears", async ({ page, mockWallet }) => {
    await page.goto("/trade/AAPL/22000");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Instrument the mock to count signature requests.
    await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const a = w.__meridianMockWallet as Record<string, unknown>;
      a._signCount = 0;
      const orig = a.signTransaction as (tx: unknown) => Promise<unknown>;
      a.signTransaction = async (tx: unknown) => {
        (a._signCount as number)++;
        return orig(tx);
      };
    });

    await page.getByRole("button", { name: /Buy\s*No/i }).click();
    await page.locator("input[name='amount'], input[type='number']").first().fill("3");
    await page.getByRole("button", { name: /Buy No for|Confirm|Submit/i }).click();

    await expect(page.getByText(/confirmed|success/i)).toBeVisible({ timeout: 15_000 });

    // Exactly one signature.
    const count = await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const a = w.__meridianMockWallet as Record<string, unknown>;
      return a._signCount as number;
    });
    expect(count).toBe(1);

    // NO balance present in portfolio / header
    await expect(
      page.locator("header, [data-testid='no-balance']").filter({ hasText: /NO|3/ }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
