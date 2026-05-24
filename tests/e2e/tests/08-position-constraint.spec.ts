/**
 * 08-position-constraint.spec.ts
 *
 * Position-constraint modal (PRD §2.8 + §17.2; IMPLEMENTATION_PLAN §5.3).
 *
 * Coverage:
 *   - User holds No tokens for AAPL/22000
 *   - Clicks "Buy Yes" → PositionConstraintModal opens with the canonical copy
 *   - "Close No + Buy Yes" button fires a single bundled transaction
 *   - On success, the original No position is closed AND the Yes order is placed
 *
 * Pre-conditions:
 *   - User has an existing No position (test 05 leaves one)
 *   - App implements T-FE-06 (PositionConstraintModal + composite-tx.ts)
 */

import { test, expect, expectWalletConnectedHeader } from "../fixtures/wallet";

test.describe("Position constraint — opposite-side guard", () => {
  test.fixme("Buy Yes while holding No → modal → Close+Buy bundled tx", async ({ page, mockWallet }) => {
    await page.goto("/trade/AAPL/22000");
    await mockWallet.connect();
    await expectWalletConnectedHeader(page);

    // Click Buy Yes
    await page.getByRole("button", { name: /Buy\s*Yes/i }).click();

    // Modal opens with canonical copy from §17.2
    const modal = page.locator(
      "[role='dialog'], [data-testid='position-constraint-modal']",
    );
    await expect(modal.first()).toBeVisible({ timeout: 5_000 });
    await expect(modal.first()).toContainText(/currently hold.*No tokens.*AAPL/i);

    // Count signatures.
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

    // Click "Close No + Buy Yes"
    await modal
      .first()
      .getByRole("button", { name: /Close.*Buy|Close \+ Buy/i })
      .click();

    await expect(page.getByText(/confirmed|success/i)).toBeVisible({ timeout: 20_000 });

    const signs = await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      return (w.__meridianMockWallet as Record<string, unknown>)._signCount as number;
    });
    expect(signs).toBe(1); // Single bundled signature — the whole point of the UX.
  });

  test.fixme("Cancel button on modal returns to trade panel unchanged", async ({ page, mockWallet }) => {
    await page.goto("/trade/AAPL/22000");
    await mockWallet.connect();
    await page.getByRole("button", { name: /Buy\s*Yes/i }).click();
    const modal = page.locator("[role='dialog']").first();
    await modal.getByRole("button", { name: /Cancel/i }).click();
    await expect(modal).toBeHidden();
  });
});
