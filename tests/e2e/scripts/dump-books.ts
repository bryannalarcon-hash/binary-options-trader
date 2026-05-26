/**
 * Diagnostic: dump every market's on-chain order book (bids + asks) so we can
 * see the REAL liquidity state right now. Reuses the automation anchor context.
 *
 *   pnpm --filter automation exec tsx ../tests/e2e/scripts/dump-books.ts
 *
 * NOT part of the app. Test-only operator helper.
 */
import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { PublicKey } from "@solana/web3.js";

const num = (v: any) =>
  typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v);

function liveLevels(arr: any[]): Array<{ price: number; size: number; owner: string }> {
  const out: Array<{ price: number; size: number; owner: string }> = [];
  for (const o of arr ?? []) {
    if (!o) continue;
    const owner = o.owner?.toBase58?.() ?? "";
    const size = num(o.size);
    if (!owner || owner === PublicKey.default.toBase58() || size === 0) continue;
    out.push({ price: num(o.price), size, owner: owner.slice(0, 4) + "…" });
  }
  return out;
}

async function main() {
  const anchor = buildAnchorContext(env.adminKeypairPath);
  const program = anchor.program;
  const programId = program.programId;
  const markets: Array<{ publicKey: PublicKey; account: any }> =
    await (program.account as any).market.all();

  const live = markets.filter((m) => !m.account.settled);
  let withLiquidity = 0;

  const report: any[] = [];
  for (const m of live) {
    const [ob] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      programId,
    );
    let bids: any[] = [];
    let asks: any[] = [];
    try {
      const book: any = await (program.account as any).orderBook.fetch(ob);
      bids = liveLevels(book.bids).sort((a, b) => b.price - a.price);
      asks = liveLevels(book.asks).sort((a, b) => a.price - b.price);
    } catch {
      /* no book account */
    }
    if (bids.length || asks.length) withLiquidity++;
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    report.push({
      market: `${m.account.ticker} > $${(num(m.account.strike) / 100).toFixed(2)}`,
      bestBid,
      bestAsk,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
      bids,
      asks,
    });
  }

  report.sort((a, b) => a.market.localeCompare(b.market));
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\nSUMMARY: ${live.length} active markets, ${withLiquidity} have ANY resting order, ${
      live.length - withLiquidity
    } are completely EMPTY books.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
