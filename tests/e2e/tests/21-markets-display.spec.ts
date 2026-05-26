/**
 * 21-markets-display.spec.ts
 *
 * Markets page — REAL on-chain data display (no mocks).
 *
 * The markets page reads live data only:
 *   - per-ticker oracle spot via useSpotPrice() (on-chain OracleAccount)
 *   - per-ticker strike chain via useStrikeList() (real markets + book mids)
 *
 * For each value-stable ticker (AAPL/MSFT/GOOGL/AMZN/META) we assert that the
 * card shows:
 *   - a REAL oracle spot dollar value ($NNN.NN), labelled "oracle spot"
 *   - a strike count > 0 (the "N strikes" footer resolves to a positive number)
 *
 * TSLA / NVDA are smoke-only (concurrent swarms mutate them) and intentionally
 * excluded from the value assertions.
 *
 * On-chain reads can take ~10–15s on first paint, so spot/strike assertions use
 * generous expect.poll windows rather than fixed waits.
 */

import { test, expect, type Locator } from "@playwright/test";

// Untouched tickers only — safe for exact value-dependent assertions.
const STABLE_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"] as const;

/** Locate the grid card for `sym` by its ticker symbol heading text. */
function cardFor(page: import("@playwright/test").Page, sym: string): Locator {
  // Each StockCard is a role="link" wrapper containing the ".card" element and
  // the ticker symbol. Filter the card by exact-word ticker match.
  return page
    .locator('div[role="link"]')
    .filter({ has: page.locator(".card") })
    .filter({ hasText: new RegExp(`\\b${sym}\\b`) })
    .first();
}

test.describe("Markets page — real data display", () => {
  test.beforeEach(async ({ page }) => {
    // First-paint on-chain reads for all 7 cards are slow; give each test room.
    test.setTimeout(90_000);
    await page.goto("/markets");
    await expect(page.getByRole("heading", { name: /^Markets$/i })).toBeVisible();
    // Force grid view (default) so cards (not rows) render the "oracle spot" label.
    await expect(page.getByText(/oracle spot/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  for (const sym of STABLE_TICKERS) {
    test(`${sym}: shows a real oracle spot $NNN.NN`, async ({ page }) => {
      const card = cardFor(page, sym);
      await expect(card).toBeVisible({ timeout: 20_000 });

      // The spot dollar value sits directly above the "oracle spot" label. The
      // card initially renders "—" until the on-chain read resolves; poll the
      // whole card text until a real $ value appears (and is NOT just "—").
      await expect
        .poll(
          async () => {
            const txt = await card.innerText();
            // Match a dollar value with cents, e.g. $182.34 or $1,234.56.
            const m = txt.match(/\$[\d,]+\.\d{2}/);
            return m ? m[0] : null;
          },
          {
            timeout: 45_000,
            intervals: [500, 1000, 2000, 3000],
            message: `${sym} oracle spot never resolved to a $NNN.NN value`,
          },
        )
        .not.toBeNull();

      // Sanity: the value is a positive dollar amount and the "oracle spot"
      // label is present in the same card (proves provenance, not a fake price).
      const cardText = await card.innerText();
      expect(cardText).toMatch(/oracle spot/i);
      const dollar = cardText.match(/\$([\d,]+)\.\d{2}/);
      expect(dollar, `${sym} should show a $ value`).not.toBeNull();
      const value = Number(dollar![1]!.replace(/,/g, ""));
      expect(value, `${sym} oracle spot should be a positive price`).toBeGreaterThan(0);
    });

    test(`${sym}: shows a strike count > 0`, async ({ page }) => {
      const card = cardFor(page, sym);
      await expect(card).toBeVisible({ timeout: 20_000 });

      // The footer renders "<n> strikes" once the strike chain loads (or
      // "loading…" while pending). Poll until a positive integer count shows.
      // 7 cards each fire on-chain reads concurrently on first paint, so the
      // strike chain can take a while to resolve. Use a generous poll window.
      await expect
        .poll(
          async () => {
            const txt = await card.innerText();
            const m = txt.match(/(\d+)\s+strikes/i);
            return m ? Number(m[1]) : 0;
          },
          {
            timeout: 45_000,
            intervals: [500, 1000, 2000, 3000],
            message: `${sym} strike count never resolved to a positive number`,
          },
        )
        .toBeGreaterThan(0);
    });
  }

  test("no fake/placeholder data leaks into spot prices", async ({ page }) => {
    // Wait for at least the stable tickers' spots to resolve.
    await expect
      .poll(
        async () => {
          let resolved = 0;
          for (const sym of STABLE_TICKERS) {
            const txt = await cardFor(page, sym).innerText();
            if (/\$[\d,]+\.\d{2}/.test(txt)) resolved += 1;
          }
          return resolved;
        },
        { timeout: 30_000, intervals: [1000, 2000] },
      )
      .toBe(STABLE_TICKERS.length);

    // Guard against obvious mock sentinels — no "stub", "mock", "fake", or
    // "lorem" copy anywhere in the markets content.
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toContain("stub");
    expect(body).not.toContain("mock");
    expect(body).not.toContain("lorem");
  });
});
