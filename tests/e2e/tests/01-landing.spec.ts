/**
 * 01-landing.spec.ts
 *
 * Landing page (PRD §2.9 / IMPLEMENTATION_PLAN §16.1).
 *
 * Coverage:
 *   - Page renders with hero copy + sub-tagline
 *   - "Connect Wallet" button is visible
 *   - "Browse Markets" CTA navigates to /markets
 *   - Ticker strip renders all 7 MAG7 symbols (or skeletons during load)
 *
 * Pre-conditions:
 *   - Next.js dev server reachable at E2E_BASE_URL (default http://localhost:3000)
 *
 * If the landing route doesn't yet implement the ticker strip (current scaffold
 * shows hero + CTAs only), the related assertion is `test.fixme`'d so the rest
 * of the spec passes as-is. Remove the `.fixme` once T-FE-LD-02 lands.
 */

import { test, expect } from "@playwright/test";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

test.describe("Landing page", () => {
  test("renders hero and Browse Markets CTA", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Meridian/i);

    // Hero brand
    await expect(page.getByRole("heading", { name: /Meridian/i })).toBeVisible();

    // Sub-tagline mentions stocks / Yes / No
    const body = page.locator("body");
    await expect(body).toContainText(/MAG7|Yes\/No|stocks|on chain/i);

    // Browse Markets is a real link
    const browse = page.getByRole("link", { name: /Browse markets/i });
    await expect(browse).toBeVisible();
  });

  test("Connect Wallet button is visible in header", async ({ page }) => {
    await page.goto("/");
    // @solana/wallet-adapter-react-ui WalletMultiButton renders "Select Wallet" pre-connect.
    const connectBtn = page
      .getByRole("button", { name: /Select Wallet|Connect Wallet|Connect/i })
      .first();
    await expect(connectBtn).toBeVisible({ timeout: 10_000 });
  });

  test("Browse Markets navigates to /markets", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Browse markets/i }).click();
    await page.waitForURL("**/markets");
    await expect(page.getByRole("heading", { name: /Markets/i })).toBeVisible();
  });

  // Pending: per IMPLEMENTATION_PLAN §16.1 the ticker strip is a required element.
  // The current scaffolded landing page (app/app/page.tsx) does not yet
  // implement it (it shows hero + two CTAs only). Marked .fixme so the spec
  // doesn't false-fail; remove .fixme when T-FE-LD-02 lands.
  test.fixme("ticker strip renders all 7 MAG7 symbols", async ({ page }) => {
    await page.goto("/");
    for (const sym of MAG7) {
      await expect(page.getByText(new RegExp(`\\b${sym}\\b`))).toBeVisible({
        timeout: 10_000,
      });
    }
  });
});
