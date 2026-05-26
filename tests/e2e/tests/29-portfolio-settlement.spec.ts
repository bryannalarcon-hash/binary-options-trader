import { test, expect } from "@playwright/test";
import { connectAndFund } from "../fixtures/demo-wallet";

// Portfolio settlement view (REAL on-chain). Verifies the UI-gap fix:
//   - ITM/OTM pill (mark-based) is consistent with the "In the money" stat
//     (no position is "winning" in one place and "losing" in another),
//   - an "If it wins" column shows the settlement payout + profit,
//   - the cost basis populates from the USER-scoped history scan even on a busy
//     program (regression for the program-wide-scan bug).
// Requires a seeded book (MM asks) so a market buy fills with a real cost basis
// — run after `pnpm mm:seed`.
test("portfolio shows ITM pill + 'If it wins' payout/profit, consistent labels", async ({ page }) => {
  // Cold portfolio load (markets + positions + user-scoped history scan) is slow
  // on a busy seeded localnet — give the whole flow room beyond the 60s default.
  test.setTimeout(180_000);
  await page.goto("/");
  await connectAndFund(page, 1, 5);

  // Buy YES on AMZN $260 (seeded ~60¢) at market → crosses the MM ask → fills.
  await page.goto("/trade/AMZN/26000");
  await expect(page.getByText(/YES · closes ≥/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Buy$/ }).click();
  const buyCta = page.getByRole("button", { name: /Buy YES ·/ });
  await expect(buyCta).toBeVisible({ timeout: 10_000 });
  await buyCta.click();
  await page.getByRole("button", { name: /Confirm|Place|Buy/i }).last().click({ noWaitAfter: true }).catch(() => {});
  await expect(page.getByText(/Bought\s+\d+\s+YES/i).first()).toBeVisible({ timeout: 30_000 });

  // Portfolio: the new consistent labels + settlement column.
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: /Portfolio/i })).toBeVisible({ timeout: 20_000 });

  // "In the money" stat replaced "Win rate ... winning/losing".
  await expect(page.getByText(/In the money/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\bwinning\s*\/\s*\d+\s*losing/i)).toHaveCount(0);

  // The open-positions table has the "If it wins" column.
  await expect(page.getByText(/If it wins/i).first()).toBeVisible({ timeout: 20_000 });

  // The only AMZN position here is the YES we just bought, so match by ticker
  // only. (Table cells concatenate without spaces in textContent — e.g.
  // "…todayYES10" — so a \byes\b word-boundary filter would never match.)
  const amznRow = page.locator("table.tbl tr").filter({ hasText: "AMZN" });
  await expect
    .poll(async () => {
      const r = page.getByRole("button", { name: /^Refresh$/ });
      if (await r.isVisible().catch(() => false)) await r.click();
      return amznRow.count();
    }, { timeout: 60_000, intervals: [2_500] })
    .toBeGreaterThan(0);
  await expect(amznRow.first()).toContainText(/ITM/);
  await expect(page.locator("table.tbl")).not.toContainText(/Winning|Trailing/);

  // History fix: scanning the USER's own signatures (not the busy program's)
  // means the buy fill is found → cost basis populates (not "—") even after the
  // MM seeded every book. Assert the row shows a real avg (¢) and a $ cost.
  const rowText = await amznRow.first().innerText();
  expect(rowText, "expected a real avg-price ¢ (cost basis derived)").toMatch(/\d+¢/);
  expect(rowText, "expected a real $ cost (not —)").toMatch(/\$\d/);
});
