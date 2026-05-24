/**
 * 07-trade-sell-no.spec.ts
 *
 * Trade page — Sell No (exit bearish). PRD §2.10 Flow 4, IMPLEMENTATION_PLAN §5.5 Flow 4.
 *
 * UX-abstracted: under the hood we buy Yes + redeem_pair, but the user sees
 * "Sell No". One signature.
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Trade — Sell No (UX-abstracted composite buy + redeem_pair)", () => {
  test.fixme("clicks Sell No from position → one signature → USDC received", async ({ page, mockWallet }) => {
    await page.goto("/portfolio");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Sell from the AAPL No position
    const row = page.locator("[data-testid='position-row']").filter({ hasText: /AAPL.*No/i }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole("button", { name: /Sell|Close/i }).click();

    await page.waitForURL(/\/trade\/AAPL/);
    const sellNo = page.getByRole("button", { name: /Sell\s*No/i });
    await expect(sellNo).toBeVisible();

    // Count signature requests.
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

    await sellNo.click();
    await expect(page.getByText(/confirmed|success/i)).toBeVisible({ timeout: 15_000 });

    const signs = await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      return (w.__meridianMockWallet as Record<string, unknown>)._signCount as number;
    });
    expect(signs).toBe(1);
  });
});
