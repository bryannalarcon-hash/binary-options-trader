/**
 * RPC failover with a circuit-breaker.
 *
 * The browser reads devnet through a CHAIN of endpoints:
 *   1. the primary RPC (`NEXT_PUBLIC_SOLANA_RPC_URL`, e.g. a Helius key),
 *   2. an optional second key (`NEXT_PUBLIC_SOLANA_RPC_URL_FALLBACK`),
 *   3. the public cluster RPC as a last resort.
 *
 * `failoverFetch` is a drop-in `fetch` for the web3.js `Connection`. When an
 * endpoint returns 429 (a capped free-tier key reporting "max usage reached")
 * or errors, it is benched for a cooldown and the SAME request is routed to the
 * next endpoint — all inside ONE fetch() call, so web3.js sees a single success
 * and never enters its own retry-storm (that storm kept hammering the capped
 * key and prevented it from recovering). Benched endpoints auto-recover after
 * the cooldown. Combine with `disableRetryOnRateLimit: true` on the Connection.
 *
 * Note: only HTTP RPC goes through here. WebSocket subscriptions
 * (`onAccountChange`) use the Connection's wsEndpoint and are unaffected.
 */

import { env } from "./env";

const PUBLIC_DEVNET = "https://api.devnet.solana.com";
const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

/** How long a 429'd / failed endpoint stays benched before we try it again. */
const COOLDOWN_MS = 60_000;

interface Endpoint {
  url: string;
  label: string;
  /** Epoch ms until which this endpoint is considered unhealthy (0 = healthy). */
  downUntil: number;
}

function buildEndpoints(): Endpoint[] {
  const out: { url: string; label: string }[] = [];
  if (env.rpcUrl) out.push({ url: env.rpcUrl, label: "primary" });
  if (env.fallbackRpcUrl && env.fallbackRpcUrl !== env.rpcUrl) {
    out.push({ url: env.fallbackRpcUrl, label: "fallback" });
  }
  // Public cluster RPC as last resort. It heavily limits getProgramAccounts but
  // still serves the cheap reads (getAccountInfo / oracle / health), so a capped
  // primary doesn't take the whole app dark.
  const isMainnet =
    (env.cluster ?? "").includes("mainnet") || env.rpcUrl.includes("mainnet");
  const pub = isMainnet ? PUBLIC_MAINNET : PUBLIC_DEVNET;
  if (!out.some((e) => e.url === pub)) out.push({ url: pub, label: "public" });

  return out.map((e) => ({ ...e, downUntil: 0 }));
}

let ENDPOINTS: Endpoint[] | null = null;
function endpoints(): Endpoint[] {
  return (ENDPOINTS ??= buildEndpoints());
}

/** Try-order: healthy endpoints first (priority), then benched ones as a last
 *  best-effort so the app never goes fully dark even if everything is cooling. */
function tryOrder(now: number): Endpoint[] {
  const eps = endpoints();
  const healthy = eps.filter((e) => e.downUntil <= now);
  if (healthy.length === eps.length) return eps;
  const benched = eps.filter((e) => e.downUntil > now);
  return healthy.length > 0 ? [...healthy, ...benched] : eps;
}

function bench(ep: Endpoint): void {
  ep.downUntil = Date.now() + COOLDOWN_MS;
  // eslint-disable-next-line no-console
  console.warn(
    `[rpc] ${ep.label} rate-limited (429) — benched ${COOLDOWN_MS / 1000}s, failing over`,
  );
}

/**
 * Drop-in `fetch` for the web3.js Connection. Ignores the Connection's nominal
 * endpoint and routes each request to the healthiest endpoint in the chain,
 * failing over on 429 / network error.
 */
export function failoverFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return (async () => {
    const tries = tryOrder(Date.now());
    let last: Response | null = null;
    for (const ep of tries) {
      try {
        // web3.js bodies are strings, so `init` is safe to reuse across attempts.
        const res = await fetch(ep.url, init);
        if (res.status === 429) {
          bench(ep);
          last = res;
          continue;
        }
        return res;
      } catch {
        bench(ep);
        last = null;
      }
    }
    return (
      last ??
      new Response(
        JSON.stringify({ error: "all RPC endpoints unavailable" }),
        { status: 503, headers: { "content-type": "application/json" } },
      )
    );
  })();
}

/** Diagnostic: current endpoint chain + health (for a status chip / console). */
export function rpcStatus(): { label: string; healthy: boolean }[] {
  const now = Date.now();
  return endpoints().map((e) => ({ label: e.label, healthy: e.downUntil <= now }));
}
