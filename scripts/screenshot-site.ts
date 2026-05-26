#!/usr/bin/env tsx
/**
 * Screenshot every page of the live Meridian site.
 *
 * Usage:
 *   tsx scripts/screenshot-site.ts [URL]
 *   URL defaults to https://meridian-app-production-f15c.up.railway.app
 *
 * Output: docs/screenshots/<order>-<name>.png (full-page)
 */

import { chromium, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE_URL = process.argv[2] ?? "https://meridian-app-production-f15c.up.railway.app";
const OUT_DIR = path.resolve(__dirname, "..", "docs", "screenshots");

fs.mkdirSync(OUT_DIR, { recursive: true });

interface Shot {
  name: string;
  path: string;
  setup?: (page: Page) => Promise<void>;
  /** waits for selectors after navigation, before screenshot */
  waitFor?: string[];
  /** delay in ms after navigation (for charts to render) */
  delay?: number;
}

const shots: Shot[] = [
  // 1. Landing
  { name: "01-landing", path: "/", delay: 1500 },

  // 2. Markets grid
  {
    name: "02-markets",
    path: "/markets",
    waitFor: ["text=/AAPL/", "text=/MSFT/"],
    delay: 14000,
  },

  // 3. Markets expanded card — try clicking the AAPL expand chevron
  {
    name: "03-markets-aapl-expanded",
    path: "/markets",
    setup: async (page) => {
      // Find AAPL card and click its expand button if visible
      try {
        const aaplCard = page.locator("text=AAPL").first();
        await aaplCard.scrollIntoViewIfNeeded({ timeout: 3000 });
      } catch {}
    },
    delay: 2000,
  },

  // 4. Trade page (AAPL ATM) — server-side redirects to a strike
  {
    name: "04-trade-aapl-default",
    path: "/trade/AAPL",
    delay: 14000,
  },

  // 5. Trade page with specific strike — find one that exists on-chain
  {
    name: "05-trade-aapl-strike",
    path: "/trade/AAPL/30000", // $300 strike, likely close to current spot
    delay: 14000,
  },

  // 6. Trade page — toggle to Implied PDF tab
  {
    name: "06-trade-implied-pdf",
    path: "/trade/AAPL/30000",
    setup: async (page) => {
      try {
        const pdfTab = page.getByRole("button", { name: /implied pdf/i });
        await pdfTab.click({ timeout: 5000 });
      } catch {}
    },
    delay: 14000,
  },

  // 7. Trade page — No perspective
  {
    name: "07-trade-no-perspective",
    path: "/trade/AAPL/30000",
    setup: async (page) => {
      try {
        const noBtn = page.getByRole("button", { name: /^no$/i }).first();
        await noBtn.click({ timeout: 5000 });
      } catch {}
    },
    delay: 2000,
  },

  // 8. Portfolio (empty, no wallet)
  { name: "08-portfolio-empty", path: "/portfolio", delay: 2000 },

  // 9. Portfolio MM dashboard
  { name: "09-portfolio-mm", path: "/portfolio/mm", delay: 2000 },

  // 10. History (empty, no wallet)
  { name: "10-history-empty", path: "/history", delay: 2000 },

  // 11. Wallet connect modal — open from landing
  {
    name: "11-wallet-connect-modal",
    path: "/",
    setup: async (page) => {
      try {
        const connectBtn = page.getByRole("button", { name: /connect wallet/i }).first();
        await connectBtn.click({ timeout: 5000 });
      } catch {}
    },
    delay: 1500,
  },

  // 12. Settings panel — open from header cog
  {
    name: "12-settings-panel",
    path: "/markets",
    setup: async (page) => {
      try {
        const settingsBtn = page.getByLabel(/settings/i).first();
        await settingsBtn.click({ timeout: 5000 });
      } catch {}
    },
    delay: 1500,
  },

  // 13. Trade for MSFT (different ticker)
  { name: "13-trade-msft", path: "/trade/MSFT", delay: 14000 },

  // 14. Trade for TSLA
  { name: "14-trade-tsla", path: "/trade/TSLA", delay: 14000 },

  // 15. Trade for NVDA (only 4 strikes after dedup)
  { name: "15-trade-nvda", path: "/trade/NVDA", delay: 14000 },
];

async function main() {
  console.log(`[screenshot] BASE_URL = ${BASE_URL}`);
  console.log(`[screenshot] OUT_DIR  = ${OUT_DIR}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  // Faster timeouts so the script doesn't hang on stalled netcalls
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);

  // Silence noisy console
  page.on("pageerror", (e) => console.warn(`[pageerror] ${e.message.slice(0, 200)}`));

  let ok = 0;
  let fail = 0;

  for (const shot of shots) {
    const out = path.join(OUT_DIR, `${shot.name}.png`);
    const url = BASE_URL + shot.path;
    try {
      console.log(`  → ${shot.name} (${shot.path})`);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      if (shot.waitFor) {
        for (const sel of shot.waitFor) {
          try {
            await page.locator(sel).first().waitFor({ timeout: 8000 });
          } catch {
            /* ignore — best effort */
          }
        }
      }
      if (shot.setup) {
        try {
          await shot.setup(page);
        } catch (e) {
          console.warn(`    (setup warning) ${(e as Error).message.slice(0, 150)}`);
        }
      }
      if (shot.delay) await page.waitForTimeout(shot.delay);
      await page.screenshot({ path: out, fullPage: true });
      ok++;
    } catch (e) {
      console.warn(`    ❌ ${(e as Error).message.slice(0, 200)}`);
      // Still take a screenshot of whatever state the page is in
      try {
        await page.screenshot({ path: out, fullPage: true });
      } catch {}
      fail++;
    }
  }

  await browser.close();
  console.log(`\n[screenshot] Done. ${ok} succeeded, ${fail} failed. Output in ${OUT_DIR}`);

  // List the saved files
  const saved = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort();
  console.log("\nSaved:");
  for (const f of saved) {
    const stat = fs.statSync(path.join(OUT_DIR, f));
    console.log(`  ${f}   ${(stat.size / 1024).toFixed(0)} KB`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
