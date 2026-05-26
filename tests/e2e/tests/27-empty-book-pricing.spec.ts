/**
 * Empty-book pricing honesty (REAL on-chain, no mocks).
 *
 * When a strike has no resting book, the displayed YES/NO price is a model
 * ESTIMATE (oracle spot vs strike), NOT an executable quote. The UI must:
 *   1. visibly mark the price as an estimate (no "buy at 62¢" on an empty book), and
 *   2. refuse to place a MARKET order (which used to silently rest a 99¢ bid) —
 *      steering the user to a LIMIT order to make a market instead.
 *
 * MAG7 markets start with empty books on a fresh localnet, so AAPL's ATM strike
 * is a reliable empty-book case here.
 */
import { test, expect } from "@playwright/test";
import { connectDemoWallet } from "../fixtures/demo-wallet";

test.describe("Empty-book pricing honesty", () => {
  test("shows an ESTIMATE marker, not an executable quote", async ({ page }) => {
    await page.goto("/trade/AAPL");
    await page.waitForURL(/\/trade\/AAPL\/\d+/, { timeout: 30_000 });

    // Header YES/NO stat marks the price as an estimate ("est · no book").
    await expect(page.getByText(/est · no book/i).first()).toBeVisible({ timeout: 40_000 });
    // Trade-panel note spells it out.
    await expect(
      page.getByText(/estimated price \(no resting book\)/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Strike-chain asterisk footnote.
    await expect(
      page.getByText(/estimate \(no resting book\)/i).first(),
    ).toBeVisible();
  });

  test("blocks a MARKET order on an empty book and steers to Limit", async ({ page }) => {
    await page.goto("/");
    await connectDemoWallet(page, 1);
    await page.goto("/trade/AAPL");
    await page.waitForURL(/\/trade\/AAPL\/\d+/, { timeout: 30_000 });
    await expect(page.getByText(/YES · closes ≥/i).first()).toBeVisible({ timeout: 30_000 });

    // Default order type is Market; on an empty book the CTA must steer to Limit
    // rather than offer to place a market order (which previously rested at 99¢).
    const steer = page.getByRole("button", { name: /No liquidity — switch to Limit/i });
    await expect(steer).toBeVisible({ timeout: 20_000 });
    await steer.click();

    // Limit mode exposes a price input → the order can now rest at the user's price.
    await expect(page.getByText(/Limit price/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
