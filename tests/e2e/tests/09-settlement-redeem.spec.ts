/**
 * 09-settlement-redeem.spec.ts
 *
 * Settlement + redeem flow (PRD §2.10 Flow 5, IMPLEMENTATION_PLAN §5.5 Flow 5).
 *
 * Coverage:
 *   - Trigger settlement (via admin override on a past-expiry market)
 *   - Position shows the $1.00 payout (winning side) or $0.00 (losing)
 *   - "Redeem" button → wallet sign → USDC balance updates
 *
 * Pre-conditions:
 *   - A market exists for AAPL/22000 that is past-expiry + 1h
 *   - Admin can call admin_settle_override OR automation has already settled
 *
 * The simplest local recipe: bootstrap script seeds an old-expiry market
 * specifically for this test (see scripts/bootstrap-localnet.sh "test fixtures").
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Settlement + Redeem", () => {
  test.fixme("settled market shows $1 payout and Redeem button works", async ({ page, mockWallet }) => {
    await page.goto("/portfolio");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Find a SETTLED position (any) — exact ticker depends on bootstrap.
    await page.getByRole("tab", { name: /Settled/i }).click().catch(() => undefined);
    const settledRow = page
      .locator("[data-testid='position-row']")
      .filter({ hasText: /\$1\.00|\$0\.00/ })
      .first();
    await expect(settledRow).toBeVisible({ timeout: 10_000 });

    await settledRow.getByRole("button", { name: /Redeem/i }).click();

    // Confirm-redeem modal (§17.5) — accept defaults
    const confirm = page.locator("[role='dialog']").filter({ hasText: /Redeem/i }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.getByRole("button", { name: /Confirm/i }).click();
    }

    await expect(page.getByText(/confirmed|success|redeemed/i)).toBeVisible({
      timeout: 15_000,
    });

    // Row should disappear from "active settled" or change status to "Redeemed".
    await expect(settledRow).not.toBeVisible({ timeout: 10_000 });
  });

  test.fixme("Redeem All bulk action triggers multiple redemptions", async ({ page, mockWallet }) => {
    await page.goto("/portfolio");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    await page.getByRole("tab", { name: /Settled/i }).click().catch(() => undefined);

    const redeemAll = page.getByRole("button", { name: /Redeem All/i });
    await expect(redeemAll).toBeVisible({ timeout: 10_000 });
    await redeemAll.click();

    // Each redemption is its own signature (or batched if Solana supports it).
    await expect(page.getByText(/confirmed|success|redeemed/i)).toBeVisible({
      timeout: 30_000,
    });
  });
});
