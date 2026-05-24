/**
 * 06-trade-sell-yes.spec.ts
 *
 * Trade page — Sell Yes (exit bullish). PRD §2.10 Flow 3, IMPLEMENTATION_PLAN §5.5 Flow 3.
 *
 * Coverage:
 *   - From an existing Yes position, click "Sell Yes" → trade panel pre-fills
 *   - Fill summary shows USDC received
 *   - Realized P&L appears in portfolio after settlement
 *
 * Pre-conditions: a prior test (or seeded position) gave the user a Yes balance
 * for AAPL/22000. The current spec assumes the trade panel exposes a "Sell Yes"
 * action when the position exists.
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Trade — Sell Yes (exit bullish)", () => {
  test.fixme("clicks Sell Yes from position → fills → realized P&L", async ({ page, mockWallet }) => {
    await page.goto("/portfolio");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Click "Sell" on the AAPL Yes position
    const positionRow = page.locator("[data-testid='position-row']").filter({
      hasText: /AAPL.*Yes/i,
    }).first();
    await expect(positionRow).toBeVisible({ timeout: 10_000 });
    await positionRow.getByRole("button", { name: /Sell|Close/i }).click();

    // Should navigate to the trade page with intent prefilled.
    await page.waitForURL(/\/trade\/AAPL/);
    const sellBtn = page.getByRole("button", { name: /Sell\s*Yes/i });
    await expect(sellBtn).toBeVisible();
    await sellBtn.click();

    await expect(page.getByText(/confirmed|success/i)).toBeVisible({ timeout: 15_000 });

    // Realized P&L appears in portfolio
    await page.goto("/portfolio");
    await expect(page.getByText(/Realized|Realized P&L|P&L/i)).toBeVisible();
  });
});
