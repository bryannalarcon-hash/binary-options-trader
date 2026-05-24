/**
 * 10-portfolio.spec.ts
 *
 * Portfolio page (PRD §2.9, IMPLEMENTATION_PLAN §16.4).
 *
 * Coverage:
 *   - /portfolio renders with Active / Settled tabs (or sections)
 *   - Active positions list shows entry price, current price, P&L
 *   - Settled tab shows past positions with payouts ($1 / $0)
 *   - "Redeem All" button exists
 *   - No-wallet state: empty page with Connect CTA
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Portfolio", () => {
  test("renders the Portfolio heading and a positions section", async ({ page }) => {
    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: /Portfolio/i })).toBeVisible();
    // Empty-state copy from the scaffold; either "No positions" or live data.
    await expect(
      page.getByText(/positions|Connect Wallet|Connect to view/i),
    ).toBeVisible();
  });

  test.fixme("active positions list shows entry/current/P&L columns", async ({ page, mockWallet }) => {
    await page.goto("/portfolio");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Tabs present
    await expect(page.getByRole("tab", { name: /Active/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Settled/i })).toBeVisible();

    // At least one column-header for P&L exists
    await expect(page.getByText(/Entry|Avg|Current|P&L/i)).toBeVisible();
  });

  test.fixme("Settled tab lists payouts and shows Redeem All", async ({ page, mockWallet }) => {
    await page.goto("/portfolio");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    await page.getByRole("tab", { name: /Settled/i }).click();
    await expect(page.getByText(/\$1\.00|\$0\.00/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /Redeem All/i })).toBeVisible();
  });
});
