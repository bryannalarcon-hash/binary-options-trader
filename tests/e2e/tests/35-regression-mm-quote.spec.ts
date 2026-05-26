/**
 * 35-regression-mm-quote.spec.ts — REAL on-chain, no mocks.
 *
 * Regression for two devnet bugs hit on the MM "Quote Both Sides" page
 * (/portfolio/mm):
 *
 *   BUG A (0xbc4 / AccountNotInitialized): the quote tx didn't create the
 *     user's USDC/YES/NO token accounts, so place_order failed on a market the
 *     wallet had no accounts on.
 *   BUG B (0x1782 / NotOrderOwner): the quote built raw place_order ix with the
 *     user's OWN ATAs as the counterparty placeholder, which the contract
 *     rejects the moment a quote *crosses* a resting order (the maker's ATA must
 *     be the counterparty).
 *
 * Both were fixed by routing each leg through `sweepCrossableLevels` (the same
 * path the trade page uses): it discovers the crossing maker and passes THAT
 * maker's ATAs, rests the remainder, and creates the user's ATAs.
 *
 * This test funds a fresh demo wallet and quotes at a high mid so the *bid*
 * crosses the seeded ask (a buy needs no inventory). Pre-fix this threw
 * NotOrderOwner; we assert neither regressed error ever surfaces.
 *
 * Run on a SEEDED stack (`pnpm mm:seed`) so there's a resting book to cross.
 */
import { test, expect } from "@playwright/test";
import { connectAndFund } from "../fixtures/demo-wallet";

const BUG_ERRORS = /NotOrderOwner|0x1782|AccountNotInitialized|0xbc4/i;

test.describe("Regression: MM Quote Both Sides on a seeded book", () => {
  test("a crossing quote discovers the maker + creates ATAs — no NotOrderOwner / AccountNotInitialized", async ({
    page,
  }) => {
    // connect+fund (≈30-50s) + the multi-tx sweep quote + toast wait exceed the
    // 60s default; give it room.
    test.setTimeout(180_000);
    // Navigate first — connectDemoWallet drives the header's connect modal and
    // assumes a page is already loaded.
    await page.goto("/portfolio/mm");
    await connectAndFund(page);

    // Quote form: Mid is the only number input capped at 98. Set it high so the
    // bid (~98¢) crosses the seeded ask on the selected market.
    const midInput = page.locator('input[max="98"]').first();
    await expect(midInput).toBeVisible({ timeout: 30_000 });
    await midInput.fill("98");

    const quoteBtn = page.getByRole("button", { name: /^Quote \d+ @/ });
    await expect(quoteBtn).toBeEnabled({ timeout: 10_000 });
    await quoteBtn.click();

    // Wait for the quote to resolve (a success "Quoted …" or a "Quote failed …"
    // toast). The ask leg may legitimately fail on insufficient YES inventory —
    // that's a DIFFERENT, acceptable error. We only assert the two REGRESSED
    // errors never appear.
    await expect(page.getByText(/Quote(d| failed)/i).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText(BUG_ERRORS)).toHaveCount(0);
  });
});
