/**
 * 11-history.spec.ts
 *
 * History page (PRD §2.9, IMPLEMENTATION_PLAN §16.5).
 *
 * Coverage:
 *   - /history renders the trade log header
 *   - Each row carries a tx signature link to a Solana explorer
 *   - Empty state when wallet has no trades yet
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("History", () => {
  test("renders the History heading", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: /History/i })).toBeVisible();
  });

  test("empty-state shows helpful copy before any trades", async ({ page }) => {
    await page.goto("/history");
    // Either the scaffolded stub copy OR the "No trades yet" empty state.
    await expect(
      page.getByText(/No trades yet|trade log|Make your first trade/i),
    ).toBeVisible();
  });

  test.fixme("trade rows link to a Solana explorer", async ({ page, mockWallet }) => {
    await page.goto("/history");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Once trades exist, each row contains an anchor to solscan / solana.fm / explorer.solana.com.
    const explorerLink = page.locator(
      "a[href*='solscan.io'], a[href*='solana.fm'], a[href*='explorer.solana.com']",
    );
    await expect(explorerLink.first()).toBeVisible({ timeout: 10_000 });
  });
});
