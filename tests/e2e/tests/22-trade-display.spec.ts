/**
 * 22-trade-display.spec.ts
 *
 * Trade page — REAL on-chain data display + price-consistency regression guard.
 *
 * Uses AAPL only (a value-stable ticker; TSLA/NVDA are mutated concurrently).
 *
 * Coverage:
 *   1. Strike chain populates with ≥1 real strike.
 *   2. PRICE CONSISTENCY (the real bug we fixed): the header "YES" cents, the
 *      trade-panel "Implied prob" first number, and the SELECTED strike-chain
 *      row's YES cents must all show the SAME number. Previously the header /
 *      panel defaulted to 50¢ on an empty book while the chain showed an
 *      oracle-spot estimate, so they disagreed.
 *   3. The order book renders an HONEST state — real rows, an explicit empty
 *      "be the first to quote", or a "Loading order book…" — never fabricated.
 *   4. A market-hours notice/label exists (MarketStatusChip). On devnet trading
 *      stays enabled regardless of the session.
 *
 * On-chain reads can take ~10–15s on first paint, so we navigate via the real
 * markets card link to land on a strike that actually exists, then poll.
 */

import { test, expect, type Page } from "@playwright/test";

const TICKER = "AAPL";

/** Read the number immediately preceding a "¢" in a chunk of text. */
function centsFrom(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/(\d{1,3})\s*¢/);
  return m ? Number(m[1]) : null;
}

/**
 * Navigate to a REAL AAPL strike. We open /trade/AAPL (no strike), which
 * client-redirects to the ATM strike derived from on-chain data, guaranteeing
 * the strike exists. Returns once the trade header + strike chain are visible.
 */
async function openAaplTrade(page: Page): Promise<number> {
  // The app fires long-lived on-chain reads, so "load" can hang — wait for
  // "domcontentloaded" (the React tree mounts well before all RPC reads settle).
  await page.goto(`/trade/${TICKER}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  // The bare-ticker page redirects to /trade/AAPL/<atmStrikeCents>.
  await page.waitForURL(/\/trade\/AAPL\/\d+/, { timeout: 40_000 });
  // Header contract block: "CONTRACT" label + AAPL.
  await expect(page.getByText(/^CONTRACT$/).first()).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/Strike chain/i).first()).toBeVisible({ timeout: 25_000 });
  const url = page.url();
  const m = url.match(/\/trade\/AAPL\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Precise header "YES" stat: the HeaderStat cell whose label is exactly YES. */
function headerYesStat(page: Page): import("@playwright/test").Locator {
  // The HeaderStat is the SMALLEST div: a "YES" label + a "<n>¢" value + aux.
  // Match label==YES and constrain to a div that also holds a ¢, then take the
  // last (innermost) such match so we skip page/section ancestor wrappers.
  return page
    .locator("div")
    .filter({ has: page.locator("span.label", { hasText: /^YES$/ }) })
    .filter({ hasText: /^YES\d{1,3}¢/ })
    .last();
}

test.describe("Trade page — AAPL real data + price consistency", () => {
  test("strike chain populates with at least one real strike", async ({ page }) => {
    await openAaplTrade(page);

    // The strike-chain header shows "<n> active" once loaded (or "loading…").
    const chainCard = page
      .locator(".card")
      .filter({ hasText: /Strike chain/i })
      .first();

    await expect
      .poll(
        async () => {
          const txt = (await chainCard.innerText()) || "";
          const m = txt.match(/(\d+)\s+active/i);
          return m ? Number(m[1]) : 0;
        },
        {
          timeout: 25_000,
          intervals: [500, 1000, 2000],
          message: "strike chain never reported ≥1 active strike",
        },
      )
      .toBeGreaterThan(0);

    // And at least one strike row (a $K link inside the chain card) is present.
    const strikeRows = chainCard.locator('a[href^="/trade/AAPL/"]');
    await expect.poll(() => strikeRows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test("header YES, trade-panel Implied prob, and selected row YES agree", async ({
    page,
  }) => {
    const strikeCents = await openAaplTrade(page);
    expect(strikeCents).toBeGreaterThan(0);

    // The three displays all derive from the SAME unified price
    // (yesDisplay = book-mid ?? strike estimate). On first paint the header may
    // briefly show a transient book-mid while the chain shows the estimate, so
    // we POLL the convergence invariant until they settle to one number — we
    // never weaken the assertion, we just wait for the data to fully resolve.

    // 1. Header "YES" cents — the innermost HeaderStat cell ("YES62¢= 62%").
    const yesStat = headerYesStat(page);
    // 2. Selected strike-chain row — links to the CURRENT strike.
    const selectedRow = page
      .locator(`a[href="/trade/AAPL/${strikeCents}"]`)
      .filter({ hasText: /¢/ })
      .first();
    // 3. Trade-panel "Implied prob" Stat ("Implied prob62% → 63%").
    const impliedStat = page
      .locator("div")
      .filter({ hasText: /^Implied prob\d/ })
      .last();

    await expect(selectedRow).toBeVisible({ timeout: 25_000 });
    await expect(impliedStat).toBeVisible({ timeout: 25_000 });

    // Snapshot reader: returns the trio only when all three are present.
    async function readTrio(): Promise<{
      header: number | null;
      row: number | null;
      implied: number | null;
    }> {
      const header = centsFrom(await yesStat.innerText().catch(() => ""));
      // The row text is "$300ATM62¢*38¢*—": first ¢ number is YES.
      const row = centsFrom(await selectedRow.innerText().catch(() => ""));
      const impliedText = (await impliedStat.innerText().catch(() => "")) || "";
      const im = impliedText.match(/(\d{1,3})\s*%/);
      const implied = im ? Number(im[1]) : null;
      return { header, row, implied };
    }

    // Poll until header === row === implied (all non-null and equal).
    await expect
      .poll(
        async () => {
          const { header, row, implied } = await readTrio();
          if (header == null || row == null || implied == null) return false;
          return header === row && row === implied;
        },
        {
          timeout: 30_000,
          intervals: [500, 1000, 2000, 3000],
          message:
            "header YES, selected strike-chain YES, and trade-panel Implied prob never converged to the same number",
        },
      )
      .toBe(true);

    // Final settled snapshot — assert the exact equality with rich messages.
    const { header, row, implied } = await readTrio();
    expect(header, "header YES should be a 1–99¢ value").toBeGreaterThanOrEqual(1);
    expect(header!).toBeLessThanOrEqual(99);
    expect(
      row,
      `selected strike-chain YES (${row}¢) must equal header YES (${header}¢)`,
    ).toBe(header);
    expect(
      implied,
      `trade-panel implied prob (${implied}%) must equal header YES (${header}¢)`,
    ).toBe(header);
  });

  test("order book shows an honest empty/loading/data state (no fake rows)", async ({
    page,
  }) => {
    await openAaplTrade(page);

    // The center order-book panel uses an "Implied prob" column header. Find
    // the panel and assert it is in exactly ONE honest state:
    //   - real rows (price ¢ + size + implied %),
    //   - explicit empty: "Book is empty — be the first to quote.", OR
    //   - loading: "Loading order book…".
    const bookPanel = page
      .locator("div")
      .filter({ hasText: /Implied prob/i })
      .first();
    await expect(bookPanel).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const txt = (await bookPanel.innerText()) || "";
          const empty = /be the first to quote|empty/i.test(txt);
          const loading = /Loading order book|No order book/i.test(txt);
          // A real data row has a "Spread" / "mid" summary line.
          const hasData = /Spread/i.test(txt) && /mid\s+\d/i.test(txt);
          if (empty) return "empty";
          if (loading) return "loading";
          if (hasData) return "data";
          return "unknown";
        },
        {
          timeout: 25_000,
          intervals: [500, 1000, 2000],
          message: "order book never reached a recognized honest state",
        },
      )
      .not.toBe("unknown");

    // Guard against fabricated/mock copy in the book panel.
    const bookText = ((await bookPanel.innerText()) || "").toLowerCase();
    expect(bookText).not.toContain("mock");
    expect(bookText).not.toContain("lorem");
  });

  test("market-hours notice/label exists (devnet keeps trading enabled)", async ({
    page,
  }) => {
    await openAaplTrade(page);

    // The MarketStatusChip renders one of LIVE / PRE-MKT / AFTER HRS / CLOSED.
    await expect(
      page.getByText(/\b(LIVE|PRE-MKT|AFTER HRS|CLOSED)\b/).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Settlement label is also part of the market-hours framing.
    await expect(page.getByText(/Settles? (in|at)/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
