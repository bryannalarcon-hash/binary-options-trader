import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Meridian E2E tests.
 *
 * Two modes:
 *   1. EXTERNAL stack (default): user runs `make e2e-up` first; we just point
 *      at http://localhost:3000. Fastest dev loop, supports browser inspection.
 *   2. AUTO stack: set E2E_AUTOSTART=1 and Playwright will launch
 *      `make e2e-up` itself and wait for the app to be reachable. Useful in CI.
 *
 * Toggle base URL with E2E_BASE_URL (default http://localhost:3000).
 *
 * NOTE: tests don't require a running stack to COMPILE — every spec is built
 * around `.fixme()` for assertions that depend on real on-chain data. Without
 * a running stack:
 *   - `test()` blocks that hit static markup pages STILL PASS (landing,
 *     markets, portfolio empty state, history empty state)
 *   - `test.fixme()` blocks are skipped and reported as such
 * Run `pnpm --filter tests test:e2e` to see the green-suite scaffold output.
 */

const AUTOSTART = process.env.E2E_AUTOSTART === "1";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  ...(AUTOSTART
    ? {
        webServer: {
          // `make e2e-up` brings up: validator + deploy + bootstrap + automation + app.
          // It backgrounds the app; we tail its stdout until /markets responds.
          command: "make -C ../.. e2e-up",
          url: process.env.E2E_BASE_URL || "http://localhost:3000",
          reuseExistingServer: true,
          timeout: 5 * 60 * 1000, // 5 min for a cold-start (validator + deploy + bootstrap)
          stdout: "pipe",
          stderr: "pipe",
        },
      }
    : {}),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
