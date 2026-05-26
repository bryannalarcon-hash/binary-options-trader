/**
 * Diagnostic: who holds the YES/NO tokens for a (ticker, strike)? Test-only.
 *   pnpm --filter automation exec tsx ../tests/e2e/scripts/who-holds.ts AMZN 25000
 */
import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { PublicKey } from "@solana/web3.js";

const num = (v: any) => (typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v));

async function holders(conn: any, mint: PublicKey, label: string) {
  const largest = await conn.getTokenLargestAccounts(mint);
  console.log(`  ${label} mint ${mint.toBase58()}:`);
  for (const acc of largest.value) {
    if (num(acc.amount) === 0) continue;
    const ai = await conn.getParsedAccountInfo(acc.address);
    const owner = (ai.value as any)?.data?.parsed?.info?.owner ?? "?";
    console.log(`    owner ${owner}  amount=${acc.amount}`);
  }
}

async function main() {
  const ticker = (process.argv[2] || "AMZN").toUpperCase();
  const strike = Number(process.argv[3] || "25000");
  const a = buildAnchorContext(env.adminKeypairPath);
  const all: any[] = await (a.program.account as any).market.all();
  const m = all.find((x) => x.account.ticker === ticker && num(x.account.strike) === strike);
  if (!m) { console.log(`${ticker} ${strike} not found`); return; }
  console.log(`${ticker} $${(strike / 100).toFixed(2)} market ${m.publicKey.toBase58()} settled=${m.account.settled}`);
  await holders(a.connection, m.account.yesMint as PublicKey, "YES");
  await holders(a.connection, m.account.noMint as PublicKey, "NO");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
