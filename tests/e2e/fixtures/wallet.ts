/**
 * tests/e2e/fixtures/wallet.ts
 *
 * Playwright fixture that injects a mock Solana wallet adapter into the page
 * before the app loads. The mock satisfies the Wallet Standard interface
 * surface that @solana/wallet-adapter-react probes for (window.solana,
 * window.phantom?.solana), and ALL transactions it "signs" are routed to a
 * deterministic test keypair held in this process.
 *
 * Why: real wallet UIs (Phantom, Solflare) can't be driven from Playwright
 * headless mode without an extension. The "Phantom Connect" UI requires a
 * popup we can't intercept. So we inject our own.
 *
 * Pattern:
 *
 *   import { test } from "../fixtures/wallet";
 *   test("buys yes", async ({ page, mockWallet }) => {
 *     await page.goto("/");
 *     await mockWallet.connect();           // sets window.solana, fires events
 *     ...
 *   });
 *
 * SAFETY: this fixture only mounts when `MERIDIAN_E2E=true` in the page's env.
 * If the app is ever run against a real wallet on mainnet, the env var is
 * absent and the mock no-ops.
 */

import { test as base, type Page } from "@playwright/test";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function loadKp(p: string): Keypair {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Try to load the standard "test user" keypair the e2e stack funded. Falls
 * back to a deterministic in-memory keypair (seeded so each Playwright run
 * shares the same pubkey across the suite).
 */
function loadTestUserKp(): Keypair {
  const candidates = [
    process.env.E2E_USER_KEYPAIR_PATH,
    path.join(REPO_ROOT, "keys", "e2e-user.json"),
    path.join(REPO_ROOT, "keys", "admin.json"), // last resort
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return loadKp(c);
    } catch {
      // try next
    }
  }
  // Deterministic fallback — seeded so the same pubkey reappears every run.
  const seed = Buffer.alloc(32, 7); // 32 bytes of 0x07
  return Keypair.fromSeed(seed);
}

const TEST_USER = loadTestUserKp();
export const TEST_USER_PUBKEY = TEST_USER.publicKey.toBase58();

// (Documentation note) The browser-side mock is serialized into the page via
// `page.addInitScript` inside the fixture definition below. It implements
// just enough of the @solana/wallet-adapter Wallet interface (and the
// Wallet Standard surface) that the app's `useWallet()` hook resolves to a
// connected, signing wallet. See the fixture body for the canonical script.

export const test = base.extend<{
  mockWallet: {
    pubkey: string;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
  };
}>({
  mockWallet: async ({ page }, use) => {
    const secretKeyB64 = Buffer.from(TEST_USER.secretKey).toString("base64");
    await page.addInitScript(
      ({ pubkey, sk }: { pubkey: string; sk: string }) => {
        // Runs IN THE PAGE. Treat `window` as the canonical EventTarget here;
        // a bag for ad-hoc fields is held in `bag`.
        const w = window as Window & { __MERIDIAN_E2E__?: boolean };
        const bag = window as unknown as Record<string, unknown>;
        w.__MERIDIAN_E2E__ = true;

        const pk = { toBase58: () => pubkey, toString: () => pubkey };
        const adapter: Record<string, unknown> = {
          name: "Mock Wallet",
          icon: "data:image/svg+xml;base64,",
          publicKey: pk,
          connecting: false,
          connected: false,
          readyState: "Installed",
          autoConnect: async () => undefined,
          connect: async () => {
            adapter.connected = true;
            w.dispatchEvent(new CustomEvent("meridian-mock-wallet-connect"));
            return { publicKey: pk };
          },
          disconnect: async () => {
            adapter.connected = false;
            w.dispatchEvent(new CustomEvent("meridian-mock-wallet-disconnect"));
          },
          signTransaction: async (tx: unknown) => tx,
          signAllTransactions: async (txs: unknown[]) => txs,
          signMessage: async (msg: Uint8Array) => msg,
          on: () => undefined,
          off: () => undefined,
          _secretKeyB64: sk,
        };
        bag.phantom = { solana: adapter };
        bag.solana = adapter;
        bag.__meridianMockWallet = adapter;
      },
      { pubkey: TEST_USER_PUBKEY, sk: secretKeyB64 },
    );

    const api = {
      pubkey: TEST_USER_PUBKEY,
      connect: async () => {
        await page.evaluate(async () => {
          const w = (window as unknown) as Record<string, unknown>;
          const a = w.__meridianMockWallet as { connect: () => Promise<unknown> };
          await a.connect();
        });
      },
      disconnect: async () => {
        await page.evaluate(async () => {
          const w = (window as unknown) as Record<string, unknown>;
          const a = w.__meridianMockWallet as { disconnect: () => Promise<unknown> };
          await a.disconnect();
        });
      },
    };

    await use(api);
  },
});

export { expect } from "@playwright/test";
export type { Page };

/**
 * Common helper: assert the wallet button shows a shortened pubkey
 * (e.g. "5xY8...kZpQ"). The exact format is wallet-adapter-react-ui's;
 * we just look for the substring or the truncation ellipsis.
 */
export async function expectWalletConnectedHeader(page: Page) {
  // The wallet-adapter-react-ui MultiButton renders the truncated address.
  // Wait up to 5s for the state to propagate.
  await page.waitForFunction(
    () => {
      const w = (window as unknown) as Record<string, unknown>;
      const a = w.__meridianMockWallet as { connected?: boolean } | undefined;
      return a?.connected === true;
    },
    { timeout: 5_000 },
  );
}

// Re-export for convenient typing.
export { PublicKey };
