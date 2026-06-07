/**
 * scripts/_reclaim-books.ts — one-time backfill: for every SETTLED market,
 * cancel the admin's stale resting MM orders (cancel_order works post-settle),
 * then close the (now empty) order book via the new close_settled_book ix,
 * reclaiming rent to the admin wallet. Skips books with third-party orders.
 * HTTP-confirm pattern (getSignatureStatuses) like _fast-seed.ts — fast on Helius.
 *
 * Env: SOLANA_RPC_URL, SOLANA_CLUSTER, MERIDIAN_PROGRAM_ID, USDC_MINT,
 *      ADMIN_KEYPAIR_PATH. Optional DRY_RUN=1 (report only, no transactions).
 */
import { PublicKey, Transaction, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { buildAnchorContext } from "../automation/src/lib/anchor";
import { configPda, orderbookPda } from "../automation/src/lib/pdas";

const DRY = process.env.DRY_RUN === "1";

async function confirmHttp(conn: Connection, sig: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) return false;
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

(async () => {
  const ctx: any = buildAnchorContext(process.env.ADMIN_KEYPAIR_PATH!);
  const { program, programId, wallet } = ctx;
  const conn = new Connection(process.env.SOLANA_RPC_URL!, { commitment: "confirmed" });
  const admin: PublicKey = wallet.publicKey;
  const [config] = configPda(programId);

  const startLamports = await conn.getBalance(admin);
  const all: any[] = await (program.account as any).market.all();
  const settled = all.filter((m) => m.account.settled);
  console.log(`markets: ${all.length} total, ${settled.length} settled`);

  let closed = 0, skippedThirdParty = 0, alreadyGone = 0, cancelled = 0, failed = 0;

  for (const m of settled) {
    const marketPk: PublicKey = m.publicKey;
    const a = m.account;
    const label = `${a.ticker} $${Number(a.strike) / 100} exp=${Number(a.expiryTs)}`;
    const [orderbook] = orderbookPda(programId, marketPk);
    let ob: any;
    try {
      ob = await (program.account as any).orderBook.fetch(orderbook);
    } catch {
      alreadyGone++;
      continue; // book already closed / never existed
    }

    try {
      // Cancel admin-owned resting orders; flag third-party ones.
      const sides: Array<["bid" | "ask", any[]]> = [
        ["bid", ob.bids],
        ["ask", ob.asks],
      ];
      let thirdParty = 0;
      for (const [side, slots] of sides) {
        for (let idx = 0; idx < slots.length; idx++) {
          const o = slots[idx];
          const empty = o.owner.equals(PublicKey.default) && Number(o.size) === 0;
          if (empty) continue;
          if (!o.owner.equals(admin)) { thirdParty++; continue; }
          if (DRY) { cancelled++; continue; }
          const ix = await (program.methods as any)
            .cancelOrder(side === "bid" ? { bid: {} } : { ask: {} }, idx)
            .accounts({
              market: marketPk,
              orderbook,
              yesMint: a.yesMint,
              usdcMint: a.usdcMint,
              userUsdc: getAssociatedTokenAddressSync(a.usdcMint, admin),
              userYes: getAssociatedTokenAddressSync(a.yesMint, admin),
              usdcEscrow: PublicKey.findProgramAddressSync(
                [Buffer.from("usdc_escrow"), marketPk.toBuffer()], programId)[0],
              yesEscrow: PublicKey.findProgramAddressSync(
                [Buffer.from("yes_escrow"), marketPk.toBuffer()], programId)[0],
              user: admin,
            })
            .instruction();
          const tx = new Transaction().add(ix);
          tx.feePayer = admin;
          tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
          const signed = await wallet.signTransaction(tx);
          const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
          if (await confirmHttp(conn, sig)) cancelled++;
          else { console.log(`  [${label} cancel ${side}#${idx}] confirm failed`); }
        }
      }
      if (thirdParty > 0) {
        skippedThirdParty++;
        console.log(`  [${label}] ${thirdParty} third-party orders — skipping close`);
        continue;
      }

      if (DRY) { closed++; continue; }
      const ix = await (program.methods as any)
        .closeSettledBook()
        .accounts({ config, market: marketPk, orderbook, admin })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = admin;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      if (await confirmHttp(conn, sig)) closed++;
      else { failed++; console.log(`  [${label} close] confirm failed`); }
    } catch (e: any) {
      failed++;
      console.log(`  [${label}] ERR ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }

  const endLamports = DRY ? startLamports : await conn.getBalance(admin);
  console.log(
    `\nDONE${DRY ? " (DRY RUN)" : ""}: closed=${closed} cancelled=${cancelled} ` +
    `thirdPartySkips=${skippedThirdParty} alreadyGone=${alreadyGone} failed=${failed}`,
  );
  console.log(`admin SOL: ${startLamports / 1e9} -> ${endLamports / 1e9} (+${(endLamports - startLamports) / 1e9})`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
