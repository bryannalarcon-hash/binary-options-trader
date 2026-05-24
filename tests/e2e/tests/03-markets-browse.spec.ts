/**
 * 03-markets-browse.spec.ts
 *
 * Markets page (IMPLEMENTATION_PLAN §16.2).
 *
 * Coverage:
 *   - Page renders 7 stock cards (MAG7)
 *   - Each card shows the ticker symbol + company name
 *   - Card link navigates to /trade/[ticker]
 *   - Live-price display: present, or a skeleton/placeholder while loading
 *   - Settlement countdown visible (sticky header / per-card) — fixme until T-FE-MK-04
 */

import { test, expect } from "@playwright/test";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

test.describe("Markets browse", () => {
  test("renders all 7 MAG7 ticker cards", async ({ page }) => {
    await page.goto("/markets");
    await expect(page.getByRole("heading", { name: /Markets/i })).toBeVisible();

    for (const sym of MAG7) {
      // Each card includes the ticker as a heading-like element.
      await expect(
        page.locator("a, div").filter({ hasText: new RegExp(`\\b${sym}\\b`) }).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("clicking a ticker card navigates to /trade/[ticker]", async ({ page }) => {
    await page.goto("/markets");
    const aaplCard = page
      .getByRole("link")
      .filter({ hasText: /\bAAPL\b/ })
      .first();
    await aaplCard.click();
    // The /trade/AAPL page immediately redirects to /trade/AAPL/0 (scaffolded ATM stub).
    await page.waitForURL(/\/trade\/AAPL/);
    await expect(page.locator("h1, h2").filter({ hasText: /AAPL/ }).first()).toBeVisible();
  });

  // Pending: live price display from anchor-client / Pyth subscription.
  // Stub today shows "— stub —" text; once T-FE-MK-01 wires it, remove fixme.
  test.fixme(
    "each card shows live price (or skeleton placeholder)",
    async ({ page }) => {
      await page.goto("/markets");
      // Either a $X.XX price, or a "Loading" / skeleton element.
      const priceOrSkel = page.locator(
        "text=/\\$\\d+\\.\\d{2}/, [data-testid='price-skel'], [aria-busy='true']",
      );
      await expect(priceOrSkel.first()).toBeVisible({ timeout: 10_000 });
    },
  );

  // Pending: settlement countdown UI (T-FE-MK-04).
  test.fixme("settlement countdown is visible", async ({ page }) => {
    await page.goto("/markets");
    await expect(
      page.getByText(/Markets settle in|settle in|expires in/i),
    ).toBeVisible();
  });
});
