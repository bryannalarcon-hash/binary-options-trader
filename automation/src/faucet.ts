import type * as http from "http";

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getMint,
  mintTo,
  transfer,
} from "@solana/spl-token";

import { env } from "./env";
import { loadKeypair } from "./lib/anchor";
import { ctx } from "./logger";

const log = ctx("faucet");

const SOL_AIRDROP = 2 * LAMPORTS_PER_SOL;
const SOL_TOPUP = 0.05 * LAMPORTS_PER_SOL; // admin→demo fallback when airdrop is throttled
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

    // 1) SOL for fees. Airdrop on localnet/devnet; if the devnet airdrop is
    //    rate-limited, fall back to a small transfer from the admin wallet so
    //    the demo wallet can always cover transaction fees.
    let solSig: string | null = null;
    try {
      solSig = await connection.requestAirdrop(address, SOL_AIRDROP);
      await connection.confirmTransaction(solSig, "confirmed");
    } catch (err) {
      log.warn({ err: errMsg(err) }, "SOL airdrop failed — transferring SOL from admin");
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: address,
            lamports: SOL_TOPUP,
          }),
        );
        solSig = await sendAndConfirmTransaction(connection, tx, [admin]);
      } catch (e) {
        log.warn({ err: errMsg(e) }, "admin SOL transfer failed (continuing to USDC)");
      }
    }

    // 2) Test USDC. If the admin keypair is the mint authority (localnet's own
    //    mint), mint fresh; otherwise (devnet's Circle USDC) transfer from the
    //    admin's pre-funded USDC stash.
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      address,
    );
    const mintInfo = await getMint(connection, mint);
    let usdcSig: string;
    if (mintInfo.mintAuthority && mintInfo.mintAuthority.equals(admin.publicKey)) {
      usdcSig = await mintTo(connection, admin, mint, ata.address, admin, USDC_AMOUNT);
    } else {
      const adminAta = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        mint,
        admin.publicKey,
      );
      usdcSig = await transfer(
        connection,
        admin,
        adminAta.address,
        ata.address,
        admin,
        USDC_AMOUNT,
      );
    }

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
