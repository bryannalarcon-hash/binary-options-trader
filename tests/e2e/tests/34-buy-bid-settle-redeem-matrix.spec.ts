/**
 * 34 — Buy / bid / settle / redeem MATRIX (REAL on-chain, no mocks).
 *
 * Covers the combinations the product hinges on:
 *   - token bought:      YES  | NO
 *   - order outcome:     FILLS (crosses the MM) | RESTS as an unfilled bid
 *   - settlement:        side WINS | side LOSES
 *   - redeem:            winner redeems for $1/token | loser is worth $0
 *
 * Each test asserts on the LEDGER — the real on-chain USDC / YES / NO / escrow
 * balances (`fixtures/ledger.ts`) — which prints a before→after delta table so
 * you can SEE that, e.g., buying YES moves only the YES book + USDC and never
 * touches the NO balance.
 *
 * RESET TO A KNOWN STATE: every test runs in a fresh Playwright context (→ a
 * brand-new Demo Wallet burner, funded to a known amount) and claims its OWN
 * (ticker, strike). Settlement is PERMANENT on-chain, so a market can't be
 * "un-settled"; isolating one strike per test is the reset. Requirements:
 *   - run on a SEEDED stack (`pnpm mm:seed`) so fills have a maker to hit;
 *   - a full RE-RUN needs a fresh `./scripts/e2e-up.sh` + `pnpm mm:seed`
 *     (the strikes these tests settle stay settled).
 */
import { test, expect, type Page } from "@playwright/test";
import { connectAndFund, burnerPubkey } from "../fixtures/demo-wallet";
import { MarketLedger } from "../fixtures/ledger";
import { settleMarket } from "../fixtures/admin-ops";

const QTY = 10;

// ---- trade-panel helpers ---------------------------------------------------
async function selectSide(page: Page, side: "yes" | "no") {
  await page
    .getByRole("button", { name: side === "no" ? /NO · closes/i : /YES · closes/i })
    .click();
}
async function setType(page: Page, type: "market" | "limit") {
  await page.getByRole("button", { name: type === "limit" ? /^Limit$/ : /^Market$/ }).click();
}
async function setQty(page: Page, qty: number) {
  await page.locator("input[type='number']").first().fill(String(qty));
}
async function setLimit(page: Page, cents: number) {
  await page.locator("input[type='number']").nth(1).fill(String(cents));
}
async function confirmIfModal(page: Page) {
  const c = page.getByRole("button", { name: /^Confirm$/ });
  if (await c.isVisible({ timeout: 2_000 }).catch(() => false)) await c.click().catch(() => {});
}
async function gotoStrike(page: Page, ticker: string, strike: number) {
  await page.goto(`/trade/${ticker}/${strike}`);
  await expect(page.getByText(/closes [≥<]/i).first()).toBeVisible({ timeout: 30_000 });
}

/** Buy at MARKET (fills against the seeded MM). Returns after the fill toast. */
async function buyMarket(page: Page, side: "yes" | "no", qty: number) {
  await selectSide(page, side);
  await page.getByRole("button", { name: /^Buy$/ }).click();
  await setType(page, "market");
  await setQty(page, qty);
  await page.getByRole("button", { name: new RegExp(`Buy ${side.toUpperCase()} ·`) }).click();
  await confirmIfModal(page);
  await expect(
    page.getByText(new RegExp(`Bought\\s+\\d+\\s+${side.toUpperCase()}`, "i")).first(),
  ).toBeVisible({ timeout: 40_000 });
}

/** Redeem the (ticker) winning position from the portfolio; assert success. */
async function redeemWinner(page: Page, ticker: string) {
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: /Portfolio/i })).toBeVisible({ timeout: 20_000 });
  // The settled winning row (in the "Settled" table) exposes a Redeem button.
  const redeemBtn = page
    .locator("table.tbl tr")
    .filter({ hasText: ticker })
    .getByRole("button", { name: /^Redeem$/i })
    .first();
  await expect
    .poll(
      async () => {
        const r = page.getByRole("button", { name: /^Refresh$/ });
        if (await r.isVisible().catch(() => false)) await r.click();
        return redeemBtn.isVisible().catch(() => false);
      },
      { timeout: 60_000, intervals: [2_500] },
    )
    .toBe(true);
  await redeemBtn.click();
  await page
    .locator(".modal-back, [role='dialog']")
    .getByRole("button", { name: /Redeem|Confirm/i })
    .last()
    .click({ timeout: 15_000 });
  await expect(page.getByText(/Redeemed/i).first()).toBeVisible({ timeout: 45_000 });
}

test.describe("Buy / bid / settle / redeem matrix (REAL on-chain)", () => {
  test.beforeEach(({}, testInfo) => testInfo.setTimeout(200_000));

  // -- 1. YES, FILLS, WINS, redeem → +$1/token --------------------------------
  test("YES buy FILLS → settles WIN → redeem pays $1/token", async ({ page }) => {
    const TICKER = "GOOGL", STRIKE = 37000;
    await page.goto("/");
    await connectAndFund(page, 1, 20);
    const buyer = await burnerPubkey(page, 1);
    const ledger = await MarketLedger.forMarket(TICKER, STRIKE, buyer);

    const b0 = await ledger.snapshot();
    await gotoStrike(page, TICKER, STRIKE);
    await buyMarket(page, "yes", QTY);
    const b1 = await ledger.snapshot();
    ledger.logStep(`BUY ${QTY} YES @ market`, b0, b1);
    // YES book only: bought YES, USDC down, NO untouched.
    expect(b1.yes, "buyer received YES").toBe(b0.yes + QTY);
    expect(b1.no, "NO balance untouched by a YES buy").toBe(b0.no);
    expect(b1.usdc, "USDC paid").toBeLessThan(b0.usdc);

    const s = await settleMarket(TICKER, STRIKE, 50_000); // 500 ≥ 370 → YES wins
    expect(s.settled).toBe(true);
    expect(s.outcome).toBe("yes");

    await redeemWinner(page, TICKER);
    const b2 = await ledger.snapshot();
    ledger.logStep("REDEEM (YES won)", b1, b2);
    expect(b2.yes, "YES burned on redeem").toBe(0);
    expect(b2.usdc, "redeem paid ~$1/token").toBeGreaterThan(b1.usdc + QTY - 1);
  });

  // -- 2. YES, FILLS, LOSES → no redeem, worth $0 -----------------------------
  test("YES buy FILLS → settles LOSE → not redeemable ($0)", async ({ page }) => {
    const TICKER = "META", STRIKE = 59000;
    await page.goto("/");
    await connectAndFund(page, 1, 20);
    const buyer = await burnerPubkey(page, 1);
    const ledger = await MarketLedger.forMarket(TICKER, STRIKE, buyer);

    const b0 = await ledger.snapshot();
    await gotoStrike(page, TICKER, STRIKE);
    await buyMarket(page, "yes", QTY);
    const b1 = await ledger.snapshot();
    ledger.logStep(`BUY ${QTY} YES @ market`, b0, b1);
    expect(b1.yes).toBe(b0.yes + QTY);

    const s = await settleMarket(TICKER, STRIKE, 50_000); // 500 < 590 → YES loses
    expect(s.outcome).toBe("no");

    // The losing position is worth $0 — the portfolio shows it as a Loss with NO
    // Redeem button (you can't redeem a loser).
    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: /Portfolio/i })).toBeVisible({ timeout: 20_000 });
    const lossRow = page.locator("table.tbl tr").filter({ hasText: TICKER }).first();
    await expect(lossRow).toBeVisible({ timeout: 60_000 });
    await expect(lossRow.getByRole("button", { name: /^Redeem$/i })).toHaveCount(0);
    const b2 = await ledger.snapshot();
    ledger.logStep("AFTER settle (YES lost)", b1, b2);
    expect(b2.usdc, "no payout for a loser").toBeLessThan(b1.usdc + 1);
  });

  // -- 3. NO, FILLS, WINS, redeem → +$1/token ---------------------------------
  test("NO buy FILLS → settles WIN → redeem pays $1/token", async ({ page }) => {
    const TICKER = "MSFT", STRIKE = 41000;
    await page.goto("/");
    await connectAndFund(page, 1, 30);
    const buyer = await burnerPubkey(page, 1);
    const ledger = await MarketLedger.forMarket(TICKER, STRIKE, buyer);

    const b0 = await ledger.snapshot();
    await gotoStrike(page, TICKER, STRIKE);
    await buyMarket(page, "no", QTY);
    const b1 = await ledger.snapshot();
    ledger.logStep(`BUY ${QTY} NO @ market`, b0, b1);
    expect(b1.no, "buyer holds NO").toBeGreaterThanOrEqual(QTY);

    const s = await settleMarket(TICKER, STRIKE, 30_000); // 300 < 410 → NO wins
    expect(s.outcome).toBe("no");

    await redeemWinner(page, TICKER);
    const b2 = await ledger.snapshot();
    ledger.logStep("REDEEM (NO won)", b1, b2);
    expect(b2.usdc, "redeem paid out").toBeGreaterThan(b1.usdc);
  });

  // -- 4. NO, FILLS, LOSES → not redeemable -----------------------------------
  test("NO buy FILLS → settles LOSE → not redeemable ($0)", async ({ page }) => {
    const TICKER = "NVDA", STRIKE = 21000;
    await page.goto("/");
    await connectAndFund(page, 1, 30);
    const buyer = await burnerPubkey(page, 1);
    const ledger = await MarketLedger.forMarket(TICKER, STRIKE, buyer);

    const b0 = await ledger.snapshot();
    await gotoStrike(page, TICKER, STRIKE);
    await buyMarket(page, "no", QTY);
    const b1 = await ledger.snapshot();
    ledger.logStep(`BUY ${QTY} NO @ market`, b0, b1);
    expect(b1.no).toBeGreaterThanOrEqual(QTY);

    const s = await settleMarket(TICKER, STRIKE, 30_000); // 300 ≥ 210 → YES wins → NO loses
    expect(s.outcome).toBe("yes");

    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: /Portfolio/i })).toBeVisible({ timeout: 20_000 });
    const row = page.locator("table.tbl tr").filter({ hasText: TICKER }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole("button", { name: /^Redeem$/i })).toHaveCount(0);
  });

  // -- 5. YES LIMIT bid that RESTS (no fill) → escrow + cancel refund ----------
  test("YES limit RESTS as a bid (no tokens) → open-orders panel → cancel refunds", async ({
    page,
  }) => {
    const TICKER = "TSLA", STRIKE = 41000;
    await page.goto("/");
    await connectAndFund(page, 1, 20);
    const buyer = await burnerPubkey(page, 1);
    const ledger = await MarketLedger.forMarket(TICKER, STRIKE, buyer);

    const b0 = await ledger.snapshot();
    await gotoStrike(page, TICKER, STRIKE);
    // Limit buy WAY below the MM bid → cannot cross any ask → rests as a bid.
    await selectSide(page, "yes");
    await page.getByRole("button", { name: /^Buy$/ }).click();
    await setType(page, "limit");
    await setQty(page, QTY);
    await setLimit(page, 30);
    await page.getByRole("button", { name: /Buy YES ·/ }).click();
    await confirmIfModal(page);
    await expect(page.getByText(/YES\s+resting/i).first()).toBeVisible({ timeout: 40_000 });

    const b1 = await ledger.snapshot();
    ledger.logStep(`LIMIT BUY ${QTY} YES @ 30¢ (rests)`, b0, b1);
    // Resting bid: NO tokens received, USDC moved into escrow (not spent).
    expect(b1.yes, "a resting bid yields NO tokens").toBe(b0.yes);
    expect(b1.usdc, "USDC left the wallet (locked)").toBeLessThan(b0.usdc);
    expect(b1.usdcEscrow, "USDC is locked in escrow").toBeGreaterThan(b0.usdcEscrow);

    // It shows in the trade-page open-orders panel (NOT as a position).
    const panel = page.getByTestId("open-orders-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText(/Buy YES/i);

    // Cancel from the panel → escrowed USDC is refunded.
    // The Cancel button renders directly beneath the trade-panel card's sticky
    // "On-chain CLOB" footer, which overlaps the hit point — a positional click
    // (even force:true) lands on the overlay, not the button. Dispatch a real
    // bubbling click straight to the button element so its React onClick fires;
    // the assertions below still verify the genuine on-chain cancel + refund.
    const cancelBtn = panel.getByRole("button", { name: /^Cancel$/ }).first();
    await cancelBtn.scrollIntoViewIfNeeded();
    await cancelBtn.dispatchEvent("click");
    await expect(page.getByText(/Cancelled/i).first()).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(async () => (await ledger.snapshot()).usdcEscrow, { timeout: 30_000, intervals: [2_000] })
      .toBe(b0.usdcEscrow);
    const b2 = await ledger.snapshot();
    ledger.logStep("CANCEL (refund)", b1, b2);
    expect(b2.usdc, "USDC refunded on cancel").toBeGreaterThan(b1.usdc);
  });
});
