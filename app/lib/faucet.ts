"use client";

import { env } from "./env";

export interface FaucetResult {
  ok: boolean;
  usdc?: number;
  ata?: string;
  error?: string;
}

/**
 * Fund the demo (burner) wallet via the automation faucet: airdrops SOL +
 * mints test USDC. Devnet/localnet only — the endpoint refuses on mainnet.
 * Returns a result object; never throws (callers surface `error`).
 */
export async function fundDemoWallet(address: string): Promise<FaucetResult> {
  if (!env.faucetUrl) {
    return { ok: false, error: "faucet not configured" };
  }
  try {
    const resp = await fetch(env.faucetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const data = (await resp.json()) as FaucetResult;
    if (!resp.ok) return { ok: false, error: data?.error || `HTTP ${resp.status}` };
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request failed" };
  }
}
