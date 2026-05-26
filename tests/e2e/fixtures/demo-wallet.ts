/**
 * Shared E2E helper: drive the REAL in-app "Demo Wallet" (burner) — no extension,
 * no mock. This is what makes headless end-to-end trading tests possible:
 * Playwright opens the connect modal, picks Demo Wallet 1/2, the app auto-funds
 * it (SOL + USDC via the automation faucet), and signs locally.
 *
 * Every burner is unique per browser context, so parallel tests don't share a
 * wallet. Trading tests should still use DISTINCT tickers to avoid colliding on
 * the same on-chain order book.
 */

import { type Page, expect } from "@playwright/test";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Read the connected demo (burner) wallet's FULL public key from localStorage —
 * needed by the on-chain balance ledger (the header only shows a short key).
 * Must be called after connecting the burner (the secret is persisted then).
 */
export async function burnerPubkey(page: Page, index: 1 | 2 = 1): Promise<PublicKey> {
  const raw = await page.evaluate(
    (i) => localStorage.getItem(`meridian.burner.secretKey.v${i}`),
    index,
  );
  if (!raw) throw new Error(`no burner secret in localStorage for index ${index}`);
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(bytes).publicKey;
}

/**
 * Open the connect modal and select Demo Wallet `index`, resiliently.
 *
 * The burner adapter intermittently fails the FIRST `select()`→`connect()` with
 * a benign `WalletConnectionError` (the modal stays open without connecting).
 * `{ noWaitAfter: true }` stops Playwright auto-waiting on the benign scheduled
 * re-render, and the retry loop re-selects until the header flips to "Demo N".
 */
export async function connectDemoWallet(page: Page, index: 1 | 2 = 1): Promise<void> {
  const header = page.locator("header");
  const openModal = () =>
    page
      .getByRole("button", { name: /Connect Wallet/i })
      .first()
      .click({ noWaitAfter: true })
      .catch(() => {});

  await openModal();
  const burnerBtn = page.locator(`button:has-text("Demo Wallet ${index}")`).first();

  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await header.innerText().catch(() => "")).includes(`Demo ${index}`)) return;
    if (await burnerBtn.isVisible().catch(() => false)) {
      await burnerBtn.click({ noWaitAfter: true });
    }
    try {
      await expect(header).toContainText(`Demo ${index}`, { timeout: 8_000 });
      return;
    } catch {
      // modal closed without connecting → re-open and retry
      if (!(await burnerBtn.isVisible().catch(() => false))) await openModal();
    }
  }
  await expect(header).toContainText(`Demo ${index}`, { timeout: 12_000 });
}

/** Read the USDC dollar amount shown in the header (0 if none). */
export async function headerUsdc(page: Page): Promise<number> {
  const txt = await page.locator("header").innerText();
  const m = txt.match(/\$([\d,]+)\.\d\d/);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
}

/**
 * Connect Demo Wallet `index`, then FUND it via the "Fund demo wallet" button in
 * the "Demo N ⚙" panel (funding is manual — not automatic on connect), and wait
 * for the credited balance to reach >= `minUsdc`.
 */
export async function connectAndFund(
  page: Page,
  index: 1 | 2 = 1,
  minUsdc = 1,
): Promise<void> {
  await connectDemoWallet(page, index);
  await openDemoPanel(page, index);
  await page.getByRole("button", { name: /Fund demo wallet/i }).first().click();
  await expect
    .poll(() => headerUsdc(page), { timeout: 40_000, intervals: [1000] })
    .toBeGreaterThanOrEqual(minUsdc);
  // Close the demo panel (Modal closes on Escape) so it doesn't block later steps.
  await page.keyboard.press("Escape");
}

/** Open the "Demo N ⚙" panel (must be connected to a demo wallet). */
export async function openDemoPanel(page: Page, index: 1 | 2 = 1): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`Demo ${index}`) }).first().click();
}
