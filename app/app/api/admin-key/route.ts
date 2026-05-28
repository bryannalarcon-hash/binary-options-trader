import { readFileSync } from "fs";
import path from "path";

import { utils } from "@coral-xyz/anchor";
import { NextResponse } from "next/server";

import { isAdminKeyServable } from "@/lib/admin-key-gate";

// Never cache — this reads a key (env var / file) at request time, server-side only.
export const dynamic = "force-dynamic";

/**
 * GET /api/admin-key — returns the admin keypair's secret (base58) so the
 * in-browser "Admin (demo)" wallet can act as the on-chain config admin /
 * oracle authority for operator demos (push oracle, settle, create markets).
 *
 * Served on localnet + DEVNET, HARD-REFUSED on mainnet (see `isAdminKeyServable`).
 * The admin key is a throwaway devnet/localnet dev key — NOT the program upgrade
 * authority, NO real funds. The secret is read server-side from the
 * `ADMIN_KEYPAIR_B64` env var (base64 of the JSON secret-key array, the same
 * convention the automation service uses on Railway) or, failing that, the
 * gitignored keys/admin.json on disk. It is NEVER bundled into client JS.
 */
export async function GET() {
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
  const rpc =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || "";
  if (!isAdminKeyServable(cluster, rpc)) {
    return NextResponse.json(
      { error: "Admin demo wallet is disabled on mainnet." },
      { status: 403 },
    );
  }

  try {
    const arr = loadAdminSecretKeyArray();
    const secret = utils.bytes.bs58.encode(Buffer.from(Uint8Array.from(arr)));
    return NextResponse.json({ secret });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "admin key unavailable" },
      { status: 500 },
    );
  }
}

/**
 * Resolve the admin secret-key byte array. Prefers `ADMIN_KEYPAIR_B64`
 * (base64-encoded JSON array — works on Railway/containers where there's no key
 * file), then falls back to reading keys/admin.json from disk (local dev).
 */
function loadAdminSecretKeyArray(): number[] {
  const b64 = process.env.ADMIN_KEYPAIR_B64?.trim();
  if (b64) {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const arr = JSON.parse(json) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(
        `ADMIN_KEYPAIR_B64 decoded to an invalid keypair (length ${arr?.length})`,
      );
    }
    return arr;
  }
  const keyPath =
    process.env.ADMIN_KEYPAIR_PATH ||
    path.join(process.cwd(), "..", "keys", "admin.json");
  return JSON.parse(readFileSync(keyPath, "utf8")) as number[];
}
