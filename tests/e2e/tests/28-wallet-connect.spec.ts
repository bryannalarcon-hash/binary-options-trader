import { test, expect } from "@playwright/test";

// TEMP: connecting a demo wallet must NOT show a false "Wallet connect failed"
// toast (the autoConnect + manual-connect double-connect race) and SHOULD show
// the success toast.
test("connecting a demo wallet shows success, not a false failure", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Connect Wallet/i }).first().click();
  await page.locator(`button:has-text("Demo Wallet 1")`).first().click();

  // Connected: header shows the Demo 1 control + the success toast.
  await expect(page.locator("header")).toContainText("Demo 1", { timeout: 20_000 });
  await expect(page.getByText(/Wallet connected/i).first()).toBeVisible({ timeout: 10_000 });

  // The false-failure toast must NOT appear.
  await expect(page.getByText(/Wallet connect failed/i)).toHaveCount(0);
});
