import type * as http from "http";

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import { env } from "./env";
import { loadKeypair } from "./lib/anchor";
import { ctx } from "./logger";

const log = ctx("faucet");

const SOL_AIRDROP = 2 * LAMPORTS_PER_SOL;
const USDC_AMOUNT = 1_000 * 1_000_000; // 1,000 USDC (6 decimals)
const COOLDOWN_MS = 20_000;
const lastFundedAt = new Map<string, number>();

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POST /faucet  { "address": "<base58 pubkey>" }
 * Airdrops SOL and mints test USDC to the address. DEVNET/LOCALNET only — the
 * USDC mint authority is the admin keypair this service holds. Hard-refused on
 * mainnet so it can never touch real assets.
 */
export async function handleFaucet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "method not allowed" });
    return;
  }
  if (env.cluster === "mainnet-beta") {
    send(res, 403, { error: "faucet disabled on mainnet" });
    return;
  }
  if (!env.usdcMint) {
    send(res, 500, { error: "USDC_MINT not configured" });
    return;
  }

  let address: PublicKey;
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { address?: string };
    if (!body.address) throw new Error("missing address");
    address = new PublicKey(body.address);
  } catch (err) {
    send(res, 400, { error: `invalid request: ${errMsg(err)}` });
    return;
  }

  const key = address.toBase58();
  const now = Date.now();
  const last = lastFundedAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) {
    send(res, 429, { error: "slow down — try again in a few seconds" });
    return;
  }
  lastFundedAt.set(key, now);

  try {
    const connection = new Connection(env.rpcUrl, { commitment: "confirmed" });
    const admin = loadKeypair(env.adminKeypairPath);
    const mint = new PublicKey(env.usdcMint);

    // 1) SOL for fees (airdrop works on localnet/devnet).
    let solSig: string | null = null;
    try {
      solSig = await connection.requestAirdrop(address, SOL_AIRDROP);
      await connection.confirmTransaction(solSig, "confirmed");
    } catch (err) {
      // Devnet airdrops are rate-limited; not fatal — the user may already have SOL.
      log.warn({ err: errMsg(err) }, "SOL airdrop failed (continuing to USDC mint)");
    }

    // 2) Test USDC via mint authority (admin).
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      address,
    );
    const usdcSig = await mintTo(
      connection,
      admin,
      mint,
      ata.address,
      admin,
      USDC_AMOUNT,
    );

    log.info({ address: key }, "faucet funded demo wallet");
    send(res, 200, {
      ok: true,
      address: key,
      solLamports: solSig ? SOL_AIRDROP : 0,
      usdc: USDC_AMOUNT / 1_000_000,
      ata: ata.address.toBase58(),
      solSig,
      usdcSig,
    });
  } catch (err) {
    const detail = errMsg(err);
    log.error(
      {
        address: key,
        err: detail,
        name: err instanceof Error ? err.name : typeof err,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "faucet failed",
    );
    send(res, 500, { error: detail });
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || err.stack?.split("\n")[0] || "Error";
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
