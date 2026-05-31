import { expect } from "chai";

/**
 * Regression for the RPC failover + circuit-breaker (added after the free-tier
 * Helius devnet key hit "max usage reached" / 429). `failoverFetch` must:
 *   - route to the primary first,
 *   - on a 429, bench that endpoint and fail over to the next, all inside ONE
 *     call (so web3.js never enters its own retry-storm),
 *   - return the first non-429 response.
 *
 * env is read at module-eval time, so set it BEFORE requiring the module.
 */
process.env.NEXT_PUBLIC_SOLANA_CLUSTER = "devnet";
process.env.NEXT_PUBLIC_SOLANA_RPC_URL = "https://primary.test/";
process.env.NEXT_PUBLIC_SOLANA_RPC_URL_FALLBACK = "https://fallback.test/";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { failoverFetch, rpcStatus } = require("../../app/lib/rpc-failover") as typeof import("../../app/lib/rpc-failover");

describe("rpc-failover", () => {
  const realFetch = globalThis.fetch;
  let hits: string[] = [];
  // Which hosts should answer 429 this run.
  let cap: Set<string>;

  beforeEach(() => {
    hits = [];
    cap = new Set();
    globalThis.fetch = (async (url: string) => {
      const host = new URL(url).host;
      hits.push(host);
      const status = cap.has(host) ? 429 : 200;
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("uses the primary when it is healthy", async () => {
    const res = await failoverFetch("ignored", { method: "POST", body: "{}" });
    expect(res.status).to.equal(200);
    expect(hits[0]).to.equal("primary.test");
  });

  it("benches a 429'd primary and fails over to the next endpoint in one call", async () => {
    cap.add("primary.test"); // primary is capped; fallback is healthy
    const res = await failoverFetch("ignored", { method: "POST", body: "{}" });
    expect(res.status).to.equal(200); // got the fallback's success
    expect(hits).to.include("primary.test");
    expect(hits).to.include("fallback.test");
    // Primary is now benched (unhealthy) per the circuit-breaker.
    const primary = rpcStatus().find((e) => e.label === "primary");
    expect(primary?.healthy).to.equal(false);
  });

  it("still returns a response (never throws) when every endpoint is capped", async () => {
    cap = new Set(["primary.test", "fallback.test", "api.devnet.solana.com"]);
    const res = await failoverFetch("ignored", { method: "POST", body: "{}" });
    expect(res.status).to.equal(429); // surfaces the cap instead of hanging/throwing
  });
});
