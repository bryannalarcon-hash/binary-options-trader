import { readFileSync } from "fs";
import path from "path";

import { utils } from "@coral-xyz/anchor";
import { NextResponse } from "next/server";

// Never cache — this reads a key file at request time, server-side only.
export const dynamic = "force-dynamic";

/**
 * GET /api/admin-key — returns the admin keypair's secret (base58) so the
 * in-browser "Admin (demo)" wallet can act as the on-chain config admin /
 * oracle authority for operator demos (push oracle, settle, create markets).
 *
 * HARD-GATED TO LOCALNET. The admin key is a throwaway localnet dev key (NOT the
 * program upgrade authority, NO real funds), but we still refuse to serve it on
 * any non-localhost cluster so it can never leak from a devnet/mainnet deploy.
 * The secret is read server-side from the gitignored keys/admin.json and is
 * NEVER bundled into client JS.
 */
export async function GET() {
  const rpc =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || "";
  const isLocalnet = rpc.includes("localhost") || rpc.includes("127.0.0.1");
  if (!isLocalnet) {
    return NextResponse.json(
      { error: "Admin demo wallet is localnet-only." },
      { status: 403 },
    );
  }

  try {
    const keyPath =
      process.env.ADMIN_KEYPAIR_PATH ||
      path.join(process.cwd(), "..", "keys", "admin.json");
    const arr = JSON.parse(readFileSync(keyPath, "utf8")) as number[];
    const secret = utils.bytes.bs58.encode(Buffer.from(Uint8Array.from(arr)));
    return NextResponse.json({ secret });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "admin key unavailable" },
      { status: 500 },
    );
  }
}
