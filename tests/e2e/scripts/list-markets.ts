/**
 * Diagnostic: list all on-chain markets (ticker / strike / settled / outcome).
 * Reuses the automation anchor context + admin keypair. Run with tsx.
 *
 *   pnpm --filter automation exec tsx ../tests/e2e/scripts/list-markets.ts
 *
 * NOT part of the app. Test-only operator helper.
 */
import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const anchor = buildAnchorContext(env.adminKeypairPath);
  const accessor = (anchor.program.account as any).market;
  const raw: Array<{ publicKey: PublicKey; account: any }> = await accessor.all();
  const rows = raw
    .map((e) => {
      const a = e.account;
      const num = (v: any) =>
        typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v);
      return {
        address: e.publicKey.toBase58(),
        ticker: a.ticker as string,
        strike: num(a.strike),
        settled: Boolean(a.settled),
        outcome: a.outcome ? JSON.stringify(a.outcome) : null,
        settlementPrice: a.settlementPrice != null ? num(a.settlementPrice) : null,
        totalPairsMinted: a.totalPairsMinted != null ? num(a.totalPairsMinted) : null,
        oracle: a.oracle?.toBase58?.() ?? null,
      };
    })
    .sort((x, y) => (x.ticker + x.strike).localeCompare(y.ticker + y.strike));
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
