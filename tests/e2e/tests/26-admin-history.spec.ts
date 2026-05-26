/**
 * 26-admin-history.spec.ts
 *
 * REAL surface checks for the operator console (/admin) and the History page
 * (/history) against the live localnet stack. No mocks.
 *
 *   /admin   — renders all dev controls (status banner, oracle push, settlement,
 *              market creation, pause) without crashing. Reads the on-chain
 *              Config + oracle PDAs. We DON'T drive admin txs here (the burner
 *              isn't the admin); we verify the console renders + is interactive.
 *
 *   /history — wallet-gated empty state when disconnected; after connecting the
 *              Demo burner it renders the Trades / Settlements / Redemptions /
 *              "My actions" tabs.
 */

import { test, expect, type Page } from "@playwright/test";

/**
 * Robust local connect+fund. Two reasons the shared connectAndFund is unreliable
 * on this stack:
 *   1. The WalletConnectModal switches to its connected view and stays open;
 *      its `.modal-back` backdrop intercepts the click to open the demo panel.
 *      We dismiss it first.
 *   2. The header USDC chip (useUsdcBalance) does NOT reflect the funded balance
 *      on this build — verified that the burner holds 2 SOL + 1000 USDC on-chain
 *      (RPC + browser fetch both return 1000) while the header keeps showing
 *      $0.00. So we gate funding on the "Topped up" success toast (confirms the
 *      on-chain faucet mint) rather than the broken header readout. The on-chain
 *      balance is what mint_pair / redeem actually consume.
 */
async function connectAndFundRobust(page: Page, index: 1 | 2 = 1) {
  await page
    .getByRole("button", { name: /Connect Wallet/i })
    .first()
    .click();
  await page.locator(`button:has-text("Demo Wallet ${index}")`).first().click();
  await expect(page.locator("header")).toContainText(`Demo ${index}`, {
    timeout: 30_000,
  });
  await dismissModals(page);
  // Open the demo panel + fund (funding is manual, not automatic on connect).
  await page.getByRole("button", { name: new RegExp(`Demo ${index}`) }).first().click();
  const fundBtn = page.getByRole("button", { name: /Fund demo wallet/i }).first();
  await expect(fundBtn).toBeVisible({ timeout: 10_000 });
  await fundBtn.click();
  // Confirm the on-chain faucet mint via its success toast.
  await expect(page.getByText(/Topped up/i)).toBeVisible({ timeout: 30_000 });
  await dismissModals(page);
}

/** Close any open modal(s) and wait for backdrops to clear. */
async function dismissModals(page: Page) {
  for (let i = 0; i < 4; i++) {
    if ((await page.locator(".modal-back").count()) === 0) break;
    // Prefer an explicit Close button; fall back to Escape, then backdrop click.
    const closeBtn = page.getByRole("button", { name: /^Close$/i }).first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  await expect(page.locator(".modal-back")).toHaveCount(0, { timeout: 10_000 });
}

test.describe("Admin operator console (/admin)", () => {
  test("renders dev controls (oracle, settlement, market creation, pause) without crashing", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/admin");

    // Page heading + DEV TOOLS label.
    await expect(
      page.getByRole("heading", { name: /Operator Console/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/DEV TOOLS · ADMIN/i)).toBeVisible();

    // 1. Status banner — when disconnected it prompts to connect (self-gating).
    await expect(page.getByText(/No wallet connected/i)).toBeVisible();

    // 2. Oracle control — section title + per-ticker rows incl. NVDA + Push btn.
    await expect(
      page.getByRole("heading", { name: /Oracle control/i }),
    ).toBeVisible();
    await expect(page.getByText("NVDA").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Push price/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Refresh all from Pyth/i }),
    ).toBeVisible();

    // 3. Settlement control — "Settle all open (N)" + section title.
    await expect(
      page.getByRole("heading", { name: /Settlement · End of day/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Settle all open/i }),
    ).toBeVisible();

    // 4. Market creation — section title + "Create today's markets".
    await expect(
      page.getByRole("heading", { name: /Market creation/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Create today's markets/i }),
    ).toBeVisible();

    // 5. Pause / unpause control.
    await expect(
      page.getByRole("heading", { name: /Pause \/ Unpause/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Pause program|Unpause program/i }),
    ).toBeVisible();

    // No uncaught client exceptions while the console mounted + polled chain.
    expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
  });

  test("reads on-chain Config PDA (admin + oracle authority surfaced)", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: /Operator Console/i }),
    ).toBeVisible({ timeout: 20_000 });

    // The status banner reads the Config PDA and renders Admin + Oracle
    // authority rows (or a clear "Config PDA not found" if undeployed). On the
    // live stack the config exists, so the Admin stat label should appear.
    await expect
      .poll(
        async () =>
          (await page.getByText(/Oracle authority/i).count()) > 0 ||
          (await page.getByText(/Config PDA not found/i).count()) > 0,
        { timeout: 25_000, intervals: [1000] },
      )
      .toBeTruthy();
    await expect(page.getByText(/Oracle authority/i).first()).toBeVisible();
  });
});

test.describe("History page (/history)", () => {
  test("is wallet-gated when disconnected", async ({ page }) => {
    await page.goto("/history");
    await expect(
      page.getByRole("heading", { name: /^History$/ }),
    ).toBeVisible({ timeout: 20_000 });
    // Disconnected: the EmptyState prompts to connect; no tab strip yet.
    await expect(
      page.getByText(/Connect a wallet to see your trade history/i),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Connect Wallet/i }).first(),
    ).toBeVisible();
  });

  test("connected: renders Trades / Settlements / Redemptions / My actions tabs", async ({
    page,
  }) => {
    // Connect on the landing page first (no page-level gated modal there), then
    // navigate to /history — the burner persists in this context's localStorage.
    // This avoids a race with the page's own WalletConnectModal backdrop.
    await page.goto("/");
    await connectAndFundRobust(page, 1);
    await page.goto("/history");

    // After connect the tab strip replaces the empty state.
    await expect(page.getByRole("button", { name: /Trades · \d/i })).toBeVisible({
      timeout: 25_000,
    });
    await expect(
      page.getByRole("button", { name: /Settlements · \d/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Redemptions · \d/i }),
    ).toBeVisible();
    // The local client-side "My actions" log tab.
    await expect(
      page.getByRole("button", { name: /My actions · \d/i }),
    ).toBeVisible();

    // Tabs are switchable: click Settlements, then Redemptions, no crash.
    await page.getByRole("button", { name: /Settlements · \d/i }).click();
    await page.getByRole("button", { name: /Redemptions · \d/i }).click();
    await page.getByRole("button", { name: /My actions · \d/i }).click();

    // Export CSV control is present in the header toolbar.
    await expect(
      page.getByRole("button", { name: /Export CSV/i }),
    ).toBeVisible();
  });
});
