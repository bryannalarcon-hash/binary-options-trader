/**
 * 25-regression.spec.ts
 *
 * Cross-route regression guard for the infinite-render-loop bug we just fixed.
 *
 * For every primary route we:
 *   1. Capture all console errors and uncaught page errors during load.
 *   2. Assert the page actually rendered (its expected heading is visible) —
 *      a status-OK proxy, since these are client-rendered Next.js pages.
 *   3. Assert ZERO "Maximum update depth exceeded" React errors (the
 *      infinite-render-loop signature) across the route.
 *   4. Assert ZERO uncaught pageerror exceptions across the route.
 *
 * Benign noise is intentionally IGNORED: WebSocket / ws connection-refused
 * errors are expected on the local stack (no live ws relay) and must not fail
 * the guard.
 */

import { test, expect, type Page } from "@playwright/test";

interface RouteSpec {
  path: string;
  /** A heading/text that proves the route rendered its real content. */
  heading: RegExp;
  /** If the route redirects, the URL we expect to settle on. */
  settleUrl?: RegExp;
}

const ROUTES: RouteSpec[] = [
  { path: "/", heading: /One question\. One day\. One outcome\.|Meridian/i },
  { path: "/markets", heading: /^Markets$/i },
  { path: "/portfolio", heading: /^Portfolio$/i },
  { path: "/history", heading: /^History$/i },
  { path: "/portfolio/mm", heading: /^Market Maker$/i },
  {
    path: "/trade/AAPL",
    heading: /^CONTRACT$|Strike chain/i,
    settleUrl: /\/trade\/AAPL\/\d+/,
  },
  { path: "/admin", heading: /Operator Console/i },
];

/** True for console/page errors that are EXPECTED on the local stack. */
function isBenign(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("websocket") ||
    m.includes("ws://") ||
    m.includes("wss://") ||
    // Connection-refused noise from absent ws relay / RPC subscription sockets.
    (m.includes("connection") && m.includes("refused")) ||
    m.includes("err_connection_refused") ||
    m.includes("failed to connect to") ||
    // Next.js dev-only hydration HMR chatter is not the bug under test.
    m.includes("[fast refresh]")
  );
}

/** The exact React signature of the infinite-render-loop bug. */
function isMaxUpdateDepth(message: string): boolean {
  return /maximum update depth exceeded/i.test(message);
}

interface Captured {
  consoleErrors: string[];
  pageErrors: string[];
}

/**
 * Navigate robustly. The app fires long-lived on-chain reads, so the network
 * rarely reaches the default "load" event — wait for "domcontentloaded" (the
 * React tree mounts well before all RPC reads settle) with a generous timeout.
 */
async function gotoRoute(page: Page, route: RouteSpec): Promise<void> {
  await page.goto(route.path, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (route.settleUrl) {
    await page.waitForURL(route.settleUrl, { timeout: 40_000 });
  }
}

/** Attach console + pageerror listeners and return the collected buffers. */
function capture(page: Page): Captured {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(`${err.name}: ${err.message}`);
  });
  return { consoleErrors, pageErrors };
}

// We capture console/pageerror ourselves; the heavy trace/video artifacts add
// no signal here and race under concurrent load (artifact-zip ENOENT). Disable
// them for this read-only sweep so the loop-guard stays deterministic. Must be
// top-level (Playwright forbids trace/video/screenshot use() inside describe).
test.use({ trace: "off", video: "off", screenshot: "off" });

test.describe("Regression — no infinite render loop across routes", () => {
  for (const route of ROUTES) {
    test(`${route.path} renders cleanly (no Maximum update depth / pageerror)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const { consoleErrors, pageErrors } = capture(page);

      await gotoRoute(page, route);

      // 1. Status-OK proxy: expected heading/content renders.
      await expect(page.getByText(route.heading).first()).toBeVisible({
        timeout: 25_000,
      });

      // Give the render loop a window to misfire: a runaway setState loop floods
      // the console within a second or two. Idle a beat after first paint.
      await page.waitForTimeout(3_000);

      // 2. ZERO "Maximum update depth exceeded" errors (the loop signature).
      const maxDepth = [...consoleErrors, ...pageErrors].filter(isMaxUpdateDepth);
      expect(
        maxDepth,
        `${route.path} emitted "Maximum update depth exceeded" (infinite render loop):\n${maxDepth.join("\n")}`,
      ).toHaveLength(0);

      // 3. ZERO uncaught pageerror (excluding benign ws/connection noise).
      const realPageErrors = pageErrors.filter((e) => !isBenign(e));
      expect(
        realPageErrors,
        `${route.path} threw uncaught page error(s):\n${realPageErrors.join("\n")}`,
      ).toHaveLength(0);
    });
  }

  test("aggregate sweep: visit every route, assert global zero loop signatures", async ({
    page,
  }) => {
    // 7 routes × (nav + heading-wait + idle) easily exceeds the 60s default.
    test.setTimeout(240_000);
    const { consoleErrors, pageErrors } = capture(page);

    for (const route of ROUTES) {
      await gotoRoute(page, route);
      await expect(page.getByText(route.heading).first()).toBeVisible({
        timeout: 25_000,
      });
      // Brief idle so any runaway setState loop has a window to flood console.
      await page.waitForTimeout(1_000);
    }

    const maxDepth = [...consoleErrors, ...pageErrors].filter(isMaxUpdateDepth);
    expect(
      maxDepth,
      `Maximum update depth exceeded seen during full sweep:\n${maxDepth.join("\n")}`,
    ).toHaveLength(0);

    const realPageErrors = pageErrors.filter((e) => !isBenign(e));
    expect(
      realPageErrors,
      `Uncaught page errors during full sweep:\n${realPageErrors.join("\n")}`,
    ).toHaveLength(0);

    // Surface the benign-but-nonzero noise for visibility (not a failure).
    const benignCount = [...consoleErrors, ...pageErrors].filter(isBenign).length;
    console.log(
      `[regression] sweep complete — ${consoleErrors.length} console errors ` +
        `(${benignCount} benign ws/connection), ${pageErrors.length} pageerrors`,
    );
  });
});
