import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

// Regression guard for the Railway automation crash loop (2026-05-26):
// the oracle/settle/morning jobs each called `buildAnchorContext` per pass,
// opening a NEW Connection (and WebSocket) every ~30s. The orphaned sockets
// never closed, retried their handshakes against a throttled RPC, and the
// resulting 429 WS storm crashed the process. The fix is `getAnchorContext`,
// which builds ONE context per signer and reuses it (one long-lived WS), plus
// a global unhandledRejection handler so a stray 429 logs instead of exiting.

function writeTempKeypair(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-anchor-"));
  const file = path.join(dir, "signer.json");
  fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return file;
}

test("getAnchorContext reuses one Connection per signer (no per-pass WS leak)", async () => {
  const { getAnchorContext, resetAnchorContextCache } = await import("./anchor");
  resetAnchorContextCache();
  const kp = writeTempKeypair();

  const first = getAnchorContext(kp);
  const second = getAnchorContext(kp);

  // Same context object AND same underlying Connection — i.e. no second
  // WebSocket was opened. This is the actual crash fix.
  assert.equal(second, first, "expected the cached context to be returned");
  assert.equal(second.connection, first.connection, "expected the Connection (and its WS) to be reused");

  // After an explicit reset a fresh context is built (a genuinely new Connection).
  resetAnchorContextCache();
  const third = getAnchorContext(kp);
  assert.notEqual(third.connection, first.connection, "expected a new Connection after cache reset");
});

test("installGlobalErrorHandlers registers an unhandledRejection handler", async () => {
  const before = process.listenerCount("unhandledRejection");
  const { installGlobalErrorHandlers } = await import("../index");
  installGlobalErrorHandlers();
  assert.ok(
    process.listenerCount("unhandledRejection") > before,
    "expected an unhandledRejection listener so a transient 429 logs instead of crashing",
  );
  assert.ok(
    process.listenerCount("uncaughtException") > 0,
    "expected an uncaughtException listener",
  );
});
