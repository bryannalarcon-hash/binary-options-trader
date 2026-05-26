/**
 * 08 — Position constraint: opposite-side guard (Buy-Yes flow requirement #8).
 *
 * "If the user already holds No tokens for this strike, the UI prompts them to
 * sell No first before buying Yes." REAL burner-driven, no mocks.
 *
 * Holding both Yes+No is permitted by the contract only transiently (mint_pair
 * gives both); the UI enforces that you can't END UP holding both FROM TRADING
 * by routing an opposite-side buy through a "close first" prompt. The close+buy
 * runs as TWO back-to-back transactions (not atomic) — the modal says so.
 *
 * Requires a SEEDED stack (`pnpm mm:seed`) so the NO buy fills.
 */
import { test, expect } from "@playwright/test";
import { connectAndFund } from "../fixtures/demo-wallet";

test.describe("Position constraint — opposite-side guard (Buy-Yes #8)", () => {
  test("holding NO + attempt Buy YES → UI prompts to close NO first (2 back-to-back txs)", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await connectAndFund(page, 1, 20);

    // Land on AAPL's ATM strike (seeded) and read it from the URL.
    await page.goto("/trade/AAPL");
    await page.waitForURL(/\/trade\/AAPL\/\d+/, { timeout: 30_000 });
    await expect(page.getByText(/closes [≥<]/i).first()).toBeVisible({ timeout: 30_000 });

    // 1. Acquire a NO position (market Buy NO = mint pair + sell YES on the book).
    await page.getByRole("button", { name: /NO · closes/i }).click();
    await page.getByRole("button", { name: /^Buy$/ }).click();
    await page.locator("input[type='number']").first().fill("10");
    await page.getByRole("button", { name: /Buy NO ·/ }).click();
    const confirm = page.getByRole("button", { name: /^Confirm$/ });
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
    await expect(page.getByText(/Bought\s+\d+\s+NO/i).first()).toBeVisible({ timeout: 40_000 });

    // 2. Wait for the NO holding to REGISTER in the panel (useHoldingForMarket
    //    polls ~5s). Must do this BEFORE attempting Buy YES, or the buy would go
    //    through (no constraint) instead of tripping the guard.
    await expect
      .poll(
        async () => {
          const t = await page
            .getByText(/You hold .* on this strike/i)
            .first()
            .innerText()
            .catch(() => "");
          const m = t.match(/(\d+)\s+NO/);
          return m ? Number(m[1]) : 0;
        },
        { timeout: 25_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);

    // 3. Now attempt Buy YES on the same strike → the guard must fire.
    await page.getByRole("button", { name: /YES · closes/i }).click();
    await page.getByRole("button", { name: /^Buy$/ }).click();
    await page.getByRole("button", { name: /Buy YES ·/ }).click();

    // 4. The modal prompts to close NO first and is HONEST that it's two
    //    back-to-back transactions (not the old "one signed transaction" claim).
    await expect(page.getByText(/Close opposite position first/i).first()).toBeVisible();
    await expect(page.getByText(/close your No position first/i)).toBeVisible();
    await expect(page.getByText(/two back-to-back transactions/i)).toBeVisible();
    await expect(page.getByText(/one signed transaction|single signature/i)).toHaveCount(0);
  });
});
