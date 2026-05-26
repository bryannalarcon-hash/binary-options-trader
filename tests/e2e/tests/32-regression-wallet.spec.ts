/**
 * 32-regression-wallet.spec.ts
 *
 * REAL wallet-connect regression suite for Meridian (no mocks). Each test pins a
 * specific shipped bug so a re-occurrence fails loudly. Drives the live stack at
 * http://localhost:3000 against the localnet validator (:8899) + automation
 * faucet (:3001). Demo wallets are in-browser burners (no extension); the
 * "Admin (demo)" wallet loads the on-chain config-admin keypair via
 * /api/admin-key (localnet-only).
 *
 * Gaps covered here (not in 20-connect-demo / 28-wallet-connect):
 *   12/13. The false "Wallet connect failed" toast on a successful connect, the
 *          success toast presence, AND the demo-panel "Switch to Demo 2" flip,
 *          all in one regression assertion.
 *   NEW.   The "Admin (demo)" wallet connects as the config admin (6GQw…) with
 *          no failure toast, /admin shows no "not the admin wallet" warning, and
 *          the connect modal lists all three wallets.
 *   14.    The demo-wallet modal no longer clips off-screen when made tall
 *          ("Reveal secret key"): the .modal stays within the viewport.
 *
 * Each browser context gets a fresh burner (localStorage is per-context), so
 * these tests are isolated and safe to run in any order.
 */

import { test, expect, type Page } from "@playwright/test";
import { connectDemoWallet, openDemoPanel } from "../fixtures/demo-wallet";

// Per-test budget: connecting + on-chain admin-key fetch + navigation can be slow.
test.setTimeout(120_000);

// The on-chain config-admin pubkey the "Admin (demo)" wallet loads. shortKey()
// renders it as "6GQw…ZayM" in the header.
const ADMIN_PREFIX = "6GQw";

/**
 * The caret Modal renders a full-screen `.modal-back` backdrop that intercepts
 * pointer events. The connect modal auto-closes AFTER connect() resolves, so
 * there's a window where the header already shows the wallet but the backdrop is
 * still mounted. Wait for it to detach (nudging with Escape) before touching the
 * header controls underneath.
 */
async function waitForBackdropGone(page: Page): Promise<void> {
  const backdrop = page.locator(".modal-back");
  if (await backdrop.count()) {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await expect(backdrop).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Wallet connect — regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Header is client-rendered; wait for the Connect button so the first click
    // isn't racing hydration.
    await expect(
      page.getByRole("button", { name: /Connect Wallet/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  // BUG 12/13: connecting a wallet always showed a false "Wallet connect failed"
  // toast. Root cause: WalletProvider has autoConnect, and WalletConnectModal
  // also called connect() — the redundant double-connect threw a benign race
  // error that became a failure toast even though the wallet had connected.
  // REGRESSION: connecting Demo Wallet 1 shows the "Demo 1" header control + the
  // "Wallet connected" success toast, and the "/Wallet connect failed/i" toast
  // has count 0. Then the demo-panel "Switch to Demo 2" flips the header to
  // "Demo 2".
  test("12/13. Demo Wallet 1 connects with success toast, no false failure, and Switch to Demo 2 flips the header", async ({
    page,
  }) => {
    await connectDemoWallet(page, 1);

    // Header shows the Demo 1 control (the connect genuinely succeeded).
    await expect(page.locator("header")).toContainText("Demo 1", {
      timeout: 20_000,
    });

    // The success toast appears…
    await expect(
      page.getByText(/Wallet connected/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // …and the false-failure toast must NOT (the double-connect race fix).
    await expect(page.getByText(/Wallet connect failed/i)).toHaveCount(0);

    // The connect modal auto-closes; clear its backdrop before opening the panel.
    await waitForBackdropGone(page);

    // Demo-panel "Switch to Demo 2" flips the header control to "Demo 2".
    await openDemoPanel(page, 1);
    await page.getByRole("button", { name: /Switch to Demo 2/ }).click();
    await expect(page.locator("header")).toContainText("Demo 2", {
      timeout: 20_000,
    });
    await expect(page.locator("header")).not.toContainText("Demo 1 ⚙");
  });

  // NEW (admin wallet): connecting "Admin (demo)" loads the on-chain config-admin
  // keypair (pubkey 6GQw…) so /admin operator actions are enabled. It is NOT a
  // burner (no "Demo N ⚙" panel).
  // REGRESSION: the connect modal lists all three no-install wallets; connecting
  // "Admin (demo)" shows "6GQw" in the header with NO failure toast; and /admin
  // shows NO "not the admin wallet" warning (operator actions enabled).
  test("NEW. Admin (demo) connects as the config admin (6GQw…), modal lists all three wallets, no failure toast, /admin operator-enabled", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Connect Wallet/i }).first().click();

    // The connect modal lists all THREE no-install wallets (burner adapters +
    // the admin adapter register asynchronously — wait for each to mount).
    await expect(
      page.locator('button:has-text("Demo Wallet 1")').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('button:has-text("Demo Wallet 2")').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('button:has-text("Admin (demo)")').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Connect "Admin (demo)" — fetches /api/admin-key and adopts the admin key.
    await page.locator('button:has-text("Admin (demo)")').first().click();

    // Header shows the admin address (starts 6GQw) → connect succeeded.
    await expect(page.locator("header")).toContainText(ADMIN_PREFIX, {
      timeout: 20_000,
    });

    // No false-failure toast (same double-connect race fix as Demo wallets).
    await expect(page.getByText(/Wallet connect failed/i)).toHaveCount(0);

    // Admin is not a burner — the "Demo N ⚙" panel must NOT appear.
    await expect(page.locator("header")).not.toContainText("Demo 1 ⚙");
    await expect(page.locator("header")).not.toContainText("Demo 2 ⚙");

    // /admin must NOT warn that this is the wrong wallet — operator actions are
    // enabled because the connected key matches the on-chain config.admin.
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/not the admin wallet/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    // Positive confirmation: the status banner recognizes us as the admin.
    await expect(page.getByText(/Connected as admin/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  // BUG 14: the demo-wallet modal was too tall and clipped off-screen — it had no
  // max-height/scroll, so when "Reveal secret key" made it tall the secret block
  // overflowed top+bottom with no way to scroll to it.
  // REGRESSION: connect Demo Wallet 1, open the "Demo 1 ⚙" panel, click "Reveal
  // secret key" (makes it tall), then assert the .modal element is fully within
  // the viewport — boundingBox top >= 0 and bottom <= viewport height (the modal
  // is capped to the viewport and scrolls internally). Uses the config-default
  // viewport (Desktop Chrome ≈ 1280×720).
  test("14. demo-wallet modal stays within the viewport when made tall (Reveal secret key)", async ({
    page,
  }) => {
    await connectDemoWallet(page, 1);
    await expect(page.locator("header")).toContainText("Demo 1", {
      timeout: 20_000,
    });
    await waitForBackdropGone(page);

    // Open the "Demo 1 ⚙" panel and reveal the secret key (makes the modal tall).
    await openDemoPanel(page, 1);
    await page.getByRole("button", { name: /Reveal secret key/ }).click();

    // The revealed base58 secret block is now rendered inside the modal.
    const secret = /[1-9A-HJ-NP-Za-km-z]{80,90}/;
    await expect(
      page.locator(".modal").getByText(secret).first(),
    ).toBeVisible({ timeout: 10_000 });

    // The tall demo-wallet modal is the .modal containing the "Demo Wallet 1"
    // heading. Assert it is fully within the viewport (capped + scrolls
    // internally instead of clipping off-screen).
    const modal = page
      .locator(".modal")
      .filter({ hasText: "Demo Wallet 1" })
      .last();
    await expect(modal).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport, "viewport size must be defined").not.toBeNull();
    const vh = viewport!.height;

    // The fix: the modal is capped to the viewport (max-height) and scrolls
    // internally, so it can never be taller than the screen (the "too high to
    // see fully" bug, where the top was clipped off and unreachable).
    const m = await modal.evaluate((el) => ({
      maxHeight: getComputedStyle(el).maxHeight,
      height: Math.round(el.getBoundingClientRect().height),
    }));
    expect(m.maxHeight, "modal must be viewport-capped (not 'none')").not.toBe("none");
    expect(parseFloat(m.maxHeight)).toBeLessThanOrEqual(vh);
    expect(m.height, "rendered modal height must not exceed the viewport").toBeLessThanOrEqual(vh + 1);
  });
});
