/**
 * Balance ledger for E2E — reads REAL on-chain balances and logs the DELTAS
 * around each action, so a test can SHOW that (e.g.) buying YES moves only the
 * YES book + USDC: buyer USDC↓ / buyer YES↑ / yes_escrow↓ (tokens leave escrow)
 * — and NOT the NO balance. Reads directly from the validator via the shared
 * anchor context (admin keypair, read-only here).
 *
 * Decimals: USDC mint = 6 (µUSDC → shown in $). YES/NO mints = 0 (raw token
 * count). Escrows are the program's usdc_escrow / yes_escrow PDA token accounts.
 */
import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

const num = (v: any): number =>
  typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v);

export interface Balances {
  /** Buyer USDC in dollars (µUSDC / 1e6). */
  usdc: number;
  /** Buyer YES token count (mint has 0 decimals). */
  yes: number;
  /** Buyer NO token count. */
  no: number;
  /** USDC locked in the market's usdc_escrow (dollars) — backs resting BIDS. */
  usdcEscrow: number;
  /** YES locked in the market's yes_escrow (tokens) — backs resting ASKS. */
  yesEscrow: number;
}

async function bal(conn: any, ata: PublicKey, decimals: number): Promise<number> {
  try {
    const acc = await getAccount(conn, ata);
    return Number(acc.amount) / 10 ** decimals;
  } catch {
    return 0; // ATA not created yet = 0
  }
}

export class MarketLedger {
  private constructor(
    private readonly conn: any,
    private readonly buyer: PublicKey,
    private readonly usdcMint: PublicKey,
    private readonly yesMint: PublicKey,
    private readonly noMint: PublicKey,
    private readonly usdcEscrow: PublicKey,
    private readonly yesEscrow: PublicKey,
    readonly label: string,
  ) {}

  /** Resolve mints + escrow PDAs for (ticker, strike) and bind to a buyer. */
  static async forMarket(
    ticker: string,
    strikeCents: number,
    buyer: PublicKey,
  ): Promise<MarketLedger> {
    const a = buildAnchorContext(env.adminKeypairPath);
    const all: any[] = await (a.program.account as any).market.all();
    const m = all.find(
      (x) => x.account.ticker === ticker && num(x.account.strike) === strikeCents,
    );
    if (!m) throw new Error(`MarketLedger: ${ticker} $${strikeCents / 100} not found`);
    const market: PublicKey = m.publicKey;
    const usdcMint = new PublicKey(process.env.USDC_MINT!);
    const usdcEscrow = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_escrow"), market.toBuffer()],
      a.programId,
    )[0];
    const yesEscrow = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_escrow"), market.toBuffer()],
      a.programId,
    )[0];
    return new MarketLedger(
      a.connection,
      buyer,
      usdcMint,
      m.account.yesMint as PublicKey,
      m.account.noMint as PublicKey,
      usdcEscrow,
      yesEscrow,
      `${ticker} $${(strikeCents / 100).toFixed(2)}`,
    );
  }

  async snapshot(): Promise<Balances> {
    const buyerUsdc = getAssociatedTokenAddressSync(this.usdcMint, this.buyer);
    const buyerYes = getAssociatedTokenAddressSync(this.yesMint, this.buyer);
    const buyerNo = getAssociatedTokenAddressSync(this.noMint, this.buyer);
    const [usdc, yes, no, usdcEscrow, yesEscrow] = await Promise.all([
      bal(this.conn, buyerUsdc, 6),
      bal(this.conn, buyerYes, 0),
      bal(this.conn, buyerNo, 0),
      bal(this.conn, this.usdcEscrow, 6),
      bal(this.conn, this.yesEscrow, 0),
    ]);
    return { usdc, yes, no, usdcEscrow, yesEscrow };
  }

  /** Log a labelled before→after table with deltas. */
  logStep(action: string, before: Balances, after: Balances): void {
    const d = (k: keyof Balances) => after[k] - before[k];
    const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    /* eslint-disable no-console */
    console.log(`\n[ledger:${this.label}] ${action}`);
    console.log(
      `  buyer USDC : ${before.usdc.toFixed(2)} → ${after.usdc.toFixed(2)}   (Δ ${fmt(Number(d("usdc").toFixed(2)))})`,
    );
    console.log(`  buyer YES  : ${before.yes} → ${after.yes}   (Δ ${fmt(d("yes"))})`);
    console.log(`  buyer NO   : ${before.no} → ${after.no}   (Δ ${fmt(d("no"))})`);
    console.log(
      `  usdc_escrow: ${before.usdcEscrow.toFixed(2)} → ${after.usdcEscrow.toFixed(2)}   (Δ ${fmt(Number(d("usdcEscrow").toFixed(2)))})`,
    );
    console.log(`  yes_escrow : ${before.yesEscrow} → ${after.yesEscrow}   (Δ ${fmt(d("yesEscrow"))})`);
    /* eslint-enable no-console */
  }
}
