/**
 * Meridian end-to-end Anchor tests.
 *
 * These run against a local validator launched by `anchor test`. They exercise
 * every one of the 12 program instructions plus the spec-listed edge cases.
 *
 * Time gates (settle_market expiry, admin override 1 hour delay) can't be
 * directly bypassed on a stock validator, so we set extremely small expiry
 * timestamps (e.g. now + 1 second) and `sleep` to cross them. The override
 * 1-hour delay test stubs a market with expiry_ts in the deep past.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorProvider } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  LAMPORTS_PER_SOL,
  Connection,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const IDL = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../app/lib/meridian-idl.json"),
    "utf8",
  ),
);

const PROGRAM_ID = new PublicKey(IDL.address);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => Buffer.from(s);

function findPDA(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

const CONFIG_PDA = findPDA([enc("config")]);

function marketPDA(ticker: string, strike: bigint, expiry: bigint) {
  const strikeBuf = Buffer.alloc(8);
  strikeBuf.writeBigUInt64LE(strike);
  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigInt64LE(expiry);
  return findPDA([enc("market"), enc(ticker), strikeBuf, expiryBuf]);
}

const yesMintPDA = (market: PublicKey) =>
  findPDA([enc("yes_mint"), market.toBuffer()]);
const noMintPDA = (market: PublicKey) =>
  findPDA([enc("no_mint"), market.toBuffer()]);
const orderbookPDA = (market: PublicKey) =>
  findPDA([enc("orderbook"), market.toBuffer()]);
const usdcEscrowPDA = (market: PublicKey) =>
  findPDA([enc("usdc_escrow"), market.toBuffer()]);
const yesEscrowPDA = (market: PublicKey) =>
  findPDA([enc("yes_escrow"), market.toBuffer()]);
const oraclePDA = (ticker: string) => findPDA([enc("oracle"), enc(ticker)]);

describe("meridian", function () {
  this.timeout(180_000);

  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program: any = new Program(IDL as any, provider);
  const connection: Connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Wallets
  const admin = Keypair.generate();
  const oracleAuthority = Keypair.generate();
  const feeDest = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  let usdcMint: PublicKey;
  // USDC ATA owned by the fee_destination — required by place_order's new
  // parabolic taker-fee logic. Created once in `before()` and reused across
  // every place_order test below.
  let feeDestUsdc: PublicKey;

  // Per-ticker state used across tests.
  const TICKER = "AAPL";
  let oracle: PublicKey;

  before(async () => {
    // Airdrop SOL to admins/users.
    for (const kp of [admin, oracleAuthority, feeDest, user1, user2]) {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig);
    }

    // Mint a fresh USDC SPL token (6 decimals).
    usdcMint = await createMint(connection, payer, payer.publicKey, null, 6);

    // Create the fee_destination's USDC ATA. The bootstrap script does this
    // on devnet; for unit tests we make it explicit here.
    const feeAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      feeDest.publicKey,
    );
    feeDestUsdc = feeAta.address;

    oracle = oraclePDA(TICKER);
  });

  describe("1. initialize_config", () => {
    it("initializes the global config", async () => {
      await program.methods
        .initializeConfig(
          admin.publicKey,
          feeDest.publicKey,
          oracleAuthority.publicKey,
          usdcMint,
        )
        .accounts({
          config: CONFIG_PDA,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const cfg: any = await (program.account as any).config.fetch(CONFIG_PDA);
      expect(cfg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(cfg.feeDestination.toBase58()).to.equal(feeDest.publicKey.toBase58());
      expect(cfg.oracleAuthority.toBase58()).to.equal(oracleAuthority.publicKey.toBase58());
      expect(cfg.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(cfg.paused).to.equal(false);
    });
  });

  describe("2. update_oracle", () => {
    it("oracle_authority can init+write a mock oracle price", async () => {
      const price = new BN(23000); // $230.00 in cents
      const conf = new BN(50); // 0.5 cents = ~0.2% confidence
      const publishTime = new BN(Math.floor(Date.now() / 1000));
      const expo = -2;

      await program.methods
        .updateOracle(TICKER, price, conf, publishTime, expo)
        .accounts({
          config: CONFIG_PDA,
          oracleAuthority: oracleAuthority.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleAuthority])
        .rpc();

      const o: any = await (program.account as any).oracleAccount.fetch(oracle);
      expect(o.price.toString()).to.equal("23000");
      expect(o.ticker).to.equal(TICKER);
    });

    it("rejects update from a non-oracle-authority signer", async () => {
      try {
        await program.methods
          .updateOracle(TICKER, new BN(1), new BN(1), new BN(1), -2)
          .accounts({
            config: CONFIG_PDA,
            oracleAuthority: user1.publicKey,
            oracle,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have failed");
      } catch (e: any) {
        // Either Anchor address constraint or our custom error.
        expect(e.toString().toLowerCase()).to.match(/oracle|address|constraint/);
      }
    });
  });

  // ---- Build a fresh market for the trading-related tests ----
  const STRIKE = 22000n; // $220.00
  // Set the expiry far in the future for early tests so settlement can't fire.
  const FAR_EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 7200); // +2 hours
  let MARKET: PublicKey;
  let YES_MINT: PublicKey;
  let NO_MINT: PublicKey;
  let VAULT: PublicKey;

  describe("3. create_strike_market (+ init_market_books)", () => {
    it("creates a market + Yes/No mints + USDC vault", async () => {
      MARKET = marketPDA(TICKER, STRIKE, FAR_EXPIRY);
      YES_MINT = yesMintPDA(MARKET);
      NO_MINT = noMintPDA(MARKET);
      VAULT = await getAssociatedTokenAddress(usdcMint, MARKET, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE.toString()), new BN(FAR_EXPIRY.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: MARKET,
          yesMint: YES_MINT,
          noMint: NO_MINT,
          usdcMint,
          vault: VAULT,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Required second-step: init orderbook + escrows.
      await program.methods
        .initMarketBooks()
        .accounts({
          market: MARKET,
          yesMint: YES_MINT,
          usdcMint,
          orderbook: orderbookPDA(MARKET),
          usdcEscrow: usdcEscrowPDA(MARKET),
          yesEscrow: yesEscrowPDA(MARKET),
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const m: any = await (program.account as any).market.fetch(MARKET);
      expect(m.ticker).to.equal(TICKER);
      expect(m.strike.toString()).to.equal(STRIKE.toString());
      expect(m.totalPairsMinted.toString()).to.equal("0");
      expect(m.settled).to.equal(false);
    });
  });

  // Helper: fund a user with USDC + token ATAs.
  async function provisionUser(user: Keypair, usdcAmount: bigint) {
    const usdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      user.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      usdcAta.address,
      payer,
      Number(usdcAmount),
    );
    const yesAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      YES_MINT,
      user.publicKey,
    );
    const noAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      NO_MINT,
      user.publicKey,
    );
    return {
      usdc: usdcAta.address,
      yes: yesAta.address,
      no: noAta.address,
    };
  }

  let user1Atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey };
  let user2Atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey };

  describe("4. mint_pair / 5. redeem_pair", () => {
    before(async () => {
      user1Atas = await provisionUser(user1, 500_000_000n); // 500 USDC
      user2Atas = await provisionUser(user2, 500_000_000n);
    });

    it("mint_pair: user deposits 10 USDC → 10 YES + 10 NO", async () => {
      await program.methods
        .mintPair(new BN(10))
        .accounts({
          config: CONFIG_PDA,
          market: MARKET,
          yesMint: YES_MINT,
          noMint: NO_MINT,
          usdcMint,
          vault: VAULT,
          userUsdc: user1Atas.usdc,
          userYes: user1Atas.yes,
          userNo: user1Atas.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const yesBal = (await getAccount(connection, user1Atas.yes)).amount;
      const noBal = (await getAccount(connection, user1Atas.no)).amount;
      const vaultBal = (await getAccount(connection, VAULT)).amount;
      expect(yesBal.toString()).to.equal("10");
      expect(noBal.toString()).to.equal("10");
      expect(vaultBal.toString()).to.equal("10000000"); // 10 USDC
    });

    it("zero pairs rejected", async () => {
      try {
        await program.methods
          .mintPair(new BN(0))
          .accounts({
            config: CONFIG_PDA,
            market: MARKET,
            yesMint: YES_MINT,
            noMint: NO_MINT,
            usdcMint,
            vault: VAULT,
            userUsdc: user1Atas.usdc,
            userYes: user1Atas.yes,
            userNo: user1Atas.no,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have failed");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/zero|greater/);
      }
    });

    it("redeem_pair: burn 3 YES + 3 NO → 3 USDC back", async () => {
      await program.methods
        .redeemPair(new BN(3))
        .accounts({
          config: CONFIG_PDA,
          market: MARKET,
          yesMint: YES_MINT,
          noMint: NO_MINT,
          usdcMint,
          vault: VAULT,
          userUsdc: user1Atas.usdc,
          userYes: user1Atas.yes,
          userNo: user1Atas.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const yesBal = (await getAccount(connection, user1Atas.yes)).amount;
      expect(yesBal.toString()).to.equal("7");
      const vaultBal = (await getAccount(connection, VAULT)).amount;
      expect(vaultBal.toString()).to.equal("7000000");
    });
  });

  describe("6. pause / unpause", () => {
    it("admin can pause; mint_pair then rejects", async () => {
      await program.methods
        .pause(true)
        .accounts({ config: CONFIG_PDA, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      try {
        await program.methods
          .mintPair(new BN(1))
          .accounts({
            config: CONFIG_PDA,
            market: MARKET,
            yesMint: YES_MINT,
            noMint: NO_MINT,
            usdcMint,
            vault: VAULT,
            userUsdc: user1Atas.usdc,
            userYes: user1Atas.yes,
            userNo: user1Atas.no,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have failed (paused)");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/paused/);
      }

      // Unpause
      await program.methods
        .pause(false)
        .accounts({ config: CONFIG_PDA, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    it("non-admin pause is rejected", async () => {
      try {
        await program.methods
          .pause(true)
          .accounts({ config: CONFIG_PDA, admin: user1.publicKey })
          .signers([user1])
          .rpc();
        throw new Error("should have failed");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/admin|address|constraint/);
      }
    });
  });

  describe("7. place_order / 8. cancel_order", () => {
    it("user1 places a bid that rests on the book (no cross)", async () => {
      const ob = orderbookPDA(MARKET);
      const usdcEsc = usdcEscrowPDA(MARKET);
      const yesEsc = yesEscrowPDA(MARKET);

      await program.methods
        .placeOrder({ bid: {} } as any, 30, new BN(5))
        .accounts({
          config: CONFIG_PDA,
          market: MARKET,
          orderbook: ob,
          yesMint: YES_MINT,
          noMint: NO_MINT,
          usdcMint,
          userUsdc: user1Atas.usdc,
          userYes: user1Atas.yes,
          userNo: user1Atas.no,
          counterpartyUsdc: user1Atas.usdc, // placeholder
          counterpartyYes: user1Atas.yes,   // placeholder
          usdcEscrow: usdcEsc,
          yesEscrow: yesEsc,
          feeDestinationUsdc: feeDestUsdc,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([user1])
        .rpc();

      // 5 YES @ 30 cents = 5 * 30 * 10_000 = 1_500_000 micro-USDC locked
      const escBal = (await getAccount(connection, usdcEsc)).amount;
      expect(escBal.toString()).to.equal("1500000");
    });

    it("user1 cancels the resting bid (USDC returned)", async () => {
      const ob = orderbookPDA(MARKET);
      const usdcEsc = usdcEscrowPDA(MARKET);
      const yesEsc = yesEscrowPDA(MARKET);

      const balBefore = (await getAccount(connection, user1Atas.usdc)).amount;

      await program.methods
        .cancelOrder({ bid: {} } as any, 0)
        .accounts({
          market: MARKET,
          orderbook: ob,
          yesMint: YES_MINT,
          usdcMint,
          userUsdc: user1Atas.usdc,
          userYes: user1Atas.yes,
          usdcEscrow: usdcEsc,
          yesEscrow: yesEsc,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const balAfter = (await getAccount(connection, user1Atas.usdc)).amount;
      expect((balAfter - balBefore).toString()).to.equal("1500000");
      const escBal = (await getAccount(connection, usdcEsc)).amount;
      expect(escBal.toString()).to.equal("0");
    });

    it("price out of range (0 or 100) rejected", async () => {
      const ob = orderbookPDA(MARKET);
      const usdcEsc = usdcEscrowPDA(MARKET);
      const yesEsc = yesEscrowPDA(MARKET);
      try {
        await program.methods
          .placeOrder({ bid: {} } as any, 0, new BN(1))
          .accounts({
            config: CONFIG_PDA,
            market: MARKET,
            orderbook: ob,
            yesMint: YES_MINT,
            noMint: NO_MINT,
            usdcMint,
            userUsdc: user1Atas.usdc,
            userYes: user1Atas.yes,
            userNo: user1Atas.no,
            counterpartyUsdc: user1Atas.usdc,
            counterpartyYes: user1Atas.yes,
            usdcEscrow: usdcEsc,
            yesEscrow: yesEsc,
            feeDestinationUsdc: feeDestUsdc,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/price|range/);
      }
    });

    it("zero size rejected", async () => {
      const ob = orderbookPDA(MARKET);
      const usdcEsc = usdcEscrowPDA(MARKET);
      const yesEsc = yesEscrowPDA(MARKET);
      try {
        await program.methods
          .placeOrder({ bid: {} } as any, 30, new BN(0))
          .accounts({
            config: CONFIG_PDA,
            market: MARKET,
            orderbook: ob,
            yesMint: YES_MINT,
            noMint: NO_MINT,
            usdcMint,
            userUsdc: user1Atas.usdc,
            userYes: user1Atas.yes,
            userNo: user1Atas.no,
            counterpartyUsdc: user1Atas.usdc,
            counterpartyYes: user1Atas.yes,
            usdcEscrow: usdcEsc,
            yesEscrow: yesEsc,
            feeDestinationUsdc: feeDestUsdc,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/size|zero/);
      }
    });
  });

  // ----------------------------------------------------------------------
  // 7b. Parabolic taker fee — IMPLEMENTATION_PLAN §3 fee model
  // ----------------------------------------------------------------------
  //
  // taker_fee_bps = 150 * 4 * price * (100 - price) / 10_000
  //   p=50  -> 150 bps (1.5%)      PEAK
  //   p=10  -> 150 * 4 * 10 * 90 / 10_000 = 54 bps
  //   p=99  -> 150 * 4 * 99 *  1 / 10_000 =  5.94 bps  (truncated -> 5)
  //   p= 1  -> symmetric to p=99
  //
  // We use a fresh market here so we don't fight the existing order-book
  // state in §7. user1 rests the maker side; user2 takes against it.
  describe("7b. parabolic taker fee on fill", () => {
    let FEE_MARKET: PublicKey;
    let FEE_YES: PublicKey;
    let FEE_NO: PublicKey;
    let FEE_VAULT: PublicKey;
    let u1FeeAtas: { usdc: PublicKey; yes: PublicKey; no: PublicKey };
    let u2FeeAtas: { usdc: PublicKey; yes: PublicKey; no: PublicKey };

    /** Closed-form re-implementation of the on-chain fee formula. */
    function expectedFee(notional: bigint, price: number): bigint {
      if (price <= 0 || price >= 100) return 0n;
      const bps = (150n * 4n * BigInt(price) * BigInt(100 - price)) / 10_000n;
      return (notional * bps) / 10_000n;
    }

    /** Helper to place an order with the new account layout. */
    async function place(
      market: PublicKey,
      user: Keypair,
      atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey },
      cpUsdc: PublicKey,
      cpYes: PublicKey,
      side: "bid" | "ask",
      price: number,
      size: bigint,
    ) {
      const sideArg = side === "bid" ? { bid: {} } : { ask: {} };
      const accounts: Record<string, PublicKey> = {
        config: CONFIG_PDA,
        market,
        orderbook: orderbookPDA(market),
        yesMint: yesMintPDA(market),
        noMint: noMintPDA(market),
        usdcMint,
        userUsdc: atas.usdc,
        userYes: atas.yes,
        userNo: atas.no,
        counterpartyUsdc: cpUsdc,
        counterpartyYes: cpYes,
        usdcEscrow: usdcEscrowPDA(market),
        yesEscrow: yesEscrowPDA(market),
        feeDestinationUsdc: feeDestUsdc,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      };
      return (program.methods as any)
        .placeOrder(sideArg, price, new BN(size.toString()))
        .accounts(accounts)
        .signers([user])
        .rpc();
    }

    before(async () => {
      const STRIKE_FEE = 21000n; // distinct from MARKET / MARKET2
      const EXP = BigInt(Math.floor(Date.now() / 1000) + 7200);
      FEE_MARKET = marketPDA(TICKER, STRIKE_FEE, EXP);
      FEE_YES = yesMintPDA(FEE_MARKET);
      FEE_NO = noMintPDA(FEE_MARKET);
      FEE_VAULT = await getAssociatedTokenAddress(usdcMint, FEE_MARKET, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE_FEE.toString()), new BN(EXP.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: FEE_MARKET,
          yesMint: FEE_YES,
          noMint: FEE_NO,
          usdcMint,
          vault: FEE_VAULT,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .initMarketBooks()
        .accounts({
          market: FEE_MARKET,
          yesMint: FEE_YES,
          usdcMint,
          orderbook: orderbookPDA(FEE_MARKET),
          usdcEscrow: usdcEscrowPDA(FEE_MARKET),
          yesEscrow: yesEscrowPDA(FEE_MARKET),
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Fresh per-market ATAs for the YES/NO mints (USDC ATA already exists).
      const u1y = await getOrCreateAssociatedTokenAccount(connection, payer, FEE_YES, user1.publicKey);
      const u1n = await getOrCreateAssociatedTokenAccount(connection, payer, FEE_NO,  user1.publicKey);
      const u2y = await getOrCreateAssociatedTokenAccount(connection, payer, FEE_YES, user2.publicKey);
      const u2n = await getOrCreateAssociatedTokenAccount(connection, payer, FEE_NO,  user2.publicKey);
      u1FeeAtas = { usdc: user1Atas.usdc, yes: u1y.address, no: u1n.address };
      u2FeeAtas = { usdc: user2Atas.usdc, yes: u2y.address, no: u2n.address };

      // Only the MAKER (user1) mints YES inventory to post asks. The taker
      // (user2) must NOT hold NO — otherwise the book-path position guard would
      // (correctly) reject its YES-buying bids. user2 instead accumulates YES
      // from the 50¢/99¢ bid fills before it needs to sell in the 1¢ test.
      for (const [u, atas] of [[user1, u1FeeAtas]] as const) {
        await program.methods
          .mintPair(new BN(100))
          .accounts({
            config: CONFIG_PDA,
            market: FEE_MARKET,
            yesMint: FEE_YES,
            noMint: FEE_NO,
            usdcMint,
            vault: FEE_VAULT,
            userUsdc: atas.usdc,
            userYes: atas.yes,
            userNo: atas.no,
            user: u.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([u])
          .rpc();
      }
    });

    it("at price=50 (peak): fee ≈ 150 bps of notional accrues to fee_destination", async () => {
      // user1 rests an ASK @ 50¢ for 10 YES (locks YES).
      await place(FEE_MARKET, user1, u1FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "ask", 50, 10n);
      // user2 takes by BID @ 50¢ for 10 YES.
      const feeBalBefore = (await getAccount(connection, feeDestUsdc)).amount;
      await place(FEE_MARKET, user2, u2FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "bid", 50, 10n);
      const feeBalAfter = (await getAccount(connection, feeDestUsdc)).amount;

      const notional = 10n * 50n * 10_000n; // 5_000_000 micro-USDC = 5 USDC
      const expected = expectedFee(notional, 50);
      expect(expected).to.equal(75_000n); // 5 USDC * 1.5% = 0.075 USDC
      expect((feeBalAfter - feeBalBefore).toString()).to.equal(expected.toString());
    });

    it("near-edge price=99: fee is tiny (≈ 5 bps), maker gets full notional", async () => {
      // user1 rests an ASK @ 99¢ for 10 YES.
      await place(FEE_MARKET, user1, u1FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "ask", 99, 10n);
      const feeBalBefore = (await getAccount(connection, feeDestUsdc)).amount;
      const u1UsdcBefore = (await getAccount(connection, u1FeeAtas.usdc)).amount;
      await place(FEE_MARKET, user2, u2FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "bid", 99, 10n);
      const feeBalAfter = (await getAccount(connection, feeDestUsdc)).amount;
      const u1UsdcAfter = (await getAccount(connection, u1FeeAtas.usdc)).amount;

      const notional = 10n * 99n * 10_000n; // 9_900_000
      const expected = expectedFee(notional, 99);
      // 150 * 4 * 99 * 1 / 10_000 = 5 (truncated); 9_900_000 * 5 / 10_000 = 4_950
      expect(expected).to.equal(4_950n);
      expect((feeBalAfter - feeBalBefore).toString()).to.equal(expected.toString());
      // Maker (user1) receives full notional — fee comes off the taker.
      expect((u1UsdcAfter - u1UsdcBefore).toString()).to.equal(notional.toString());
    });

    it("near-edge price=1 ASK side: fee is tiny, taker nets notional - fee", async () => {
      // user1 rests a BID @ 1¢ for 10 YES (locks 10 * 1 * 10_000 = 100_000 µUSDC).
      await place(FEE_MARKET, user1, u1FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "bid", 1, 10n);
      const feeBalBefore = (await getAccount(connection, feeDestUsdc)).amount;
      const u2UsdcBefore = (await getAccount(connection, u2FeeAtas.usdc)).amount;
      // user2 takes by ASK @ 1¢ for 10 YES — sells YES into the resting bid.
      await place(FEE_MARKET, user2, u2FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "ask", 1, 10n);
      const feeBalAfter = (await getAccount(connection, feeDestUsdc)).amount;
      const u2UsdcAfter = (await getAccount(connection, u2FeeAtas.usdc)).amount;

      const notional = 10n * 1n * 10_000n; // 100_000
      const expected = expectedFee(notional, 1);
      // 150*4*1*99/10_000 = 5; 100_000 * 5 / 10_000 = 50
      expect(expected).to.equal(50n);
      expect((feeBalAfter - feeBalBefore).toString()).to.equal(expected.toString());
      // Taker nets notional - fee = 99_950
      expect((u2UsdcAfter - u2UsdcBefore).toString()).to.equal((notional - expected).toString());
    });

    it("multiple fills accumulate fees in the fee_destination ATA", async () => {
      const feeBalBefore = (await getAccount(connection, feeDestUsdc)).amount;

      // 3 separate fills at p=50: each fills 4 YES.
      for (let i = 0; i < 3; i++) {
        await place(FEE_MARKET, user1, u1FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "ask", 50, 4n);
        await place(FEE_MARKET, user2, u2FeeAtas, u1FeeAtas.usdc, u1FeeAtas.yes, "bid", 50, 4n);
      }

      const feeBalAfter = (await getAccount(connection, feeDestUsdc)).amount;
      // Per fill: notional 4*50*10_000 = 2_000_000, fee 1.5% = 30_000.
      // 3 fills => 90_000.
      const expectedTotal = 3n * expectedFee(2_000_000n, 50);
      expect(expectedTotal).to.equal(90_000n);
      expect((feeBalAfter - feeBalBefore).toString()).to.equal(expectedTotal.toString());
    });
  });

  describe("9./10. settle_market + 11. redeem", () => {
    // Build a fresh near-expiry market to test settlement.
    const STRIKE2 = 22000n;
    // Use distinct expiries: NEAR2_FAR for "settle before expiry" rejection,
    // NEAR_EXPIRY for the actual settlement test.
    let MARKET2: PublicKey;
    let YES2: PublicKey;
    let NO2: PublicKey;
    let VAULT2: PublicKey;
    let NEAR_EXPIRY: bigint;
    let FAR2: PublicKey;

    // Far-expiry market used solely for the "settle before expiry rejected" test.
    let FAR2_STRIKE = 22001n;
    let FAR2_EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 86400); // +1 day

    it("creates a near-expiry market", async () => {
      NEAR_EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 10);
      MARKET2 = marketPDA(TICKER, STRIKE2, NEAR_EXPIRY);
      YES2 = yesMintPDA(MARKET2);
      NO2 = noMintPDA(MARKET2);
      VAULT2 = await getAssociatedTokenAddress(usdcMint, MARKET2, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE2.toString()), new BN(NEAR_EXPIRY.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: MARKET2,
          yesMint: YES2,
          noMint: NO2,
          usdcMint,
          vault: VAULT2,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Also create a FAR-expiry market for the "before expiry" rejection test.
      FAR2 = marketPDA(TICKER, FAR2_STRIKE, FAR2_EXPIRY);
      await program.methods
        .createStrikeMarket(
          TICKER,
          new BN(FAR2_STRIKE.toString()),
          new BN(FAR2_EXPIRY.toString()),
        )
        .accounts({
          config: CONFIG_PDA,
          market: FAR2,
          yesMint: yesMintPDA(FAR2),
          noMint: noMintPDA(FAR2),
          usdcMint,
          vault: await getAssociatedTokenAddress(usdcMint, FAR2, true),
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    let u1m2: { usdc: PublicKey; yes: PublicKey; no: PublicKey };
    it("user1 mints pairs in the new market", async () => {
      const yesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        YES2,
        user1.publicKey,
      );
      const noAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        NO2,
        user1.publicKey,
      );
      u1m2 = { usdc: user1Atas.usdc, yes: yesAta.address, no: noAta.address };
      await program.methods
        .mintPair(new BN(20))
        .accounts({
          config: CONFIG_PDA,
          market: MARKET2,
          yesMint: YES2,
          noMint: NO2,
          usdcMint,
          vault: VAULT2,
          userUsdc: u1m2.usdc,
          userYes: u1m2.yes,
          userNo: u1m2.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
    });

    it("settle before expiry is rejected", async () => {
      try {
        await program.methods
          .settleMarket()
          .accounts({
            market: FAR2, // expiry +1 day
            oracle,
            config: CONFIG_PDA,
            caller: payer.publicKey,
          })
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/time|gate|elapsed/);
      }
    });

    it("settle after expiry with fresh oracle: at-strike → YES wins", async () => {
      // Wait until NEAR_EXPIRY has passed.
      const now = Math.floor(Date.now() / 1000);
      const waitMs = Math.max(0, Number(NEAR_EXPIRY) - now + 2) * 1000;
      if (waitMs > 0) await sleep(waitMs);

      // Push a fresh oracle update with price == strike (cents). Stamp from the
      // validator clock (test-validator time drifts ahead of wall-clock).
      const atSlot = await connection.getSlot();
      const atNow = (await connection.getBlockTime(atSlot)) ?? Math.floor(Date.now() / 1000);
      await program.methods
        .updateOracle(
          TICKER,
          new BN(22000), // price == strike → at-strike → YES wins
          new BN(20),    // conf small enough
          new BN(atNow),
          -2,
        )
        .accounts({
          config: CONFIG_PDA,
          oracleAuthority: oracleAuthority.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleAuthority])
        .rpc();

      await program.methods
        .settleMarket()
        .accounts({ market: MARKET2, oracle, config: CONFIG_PDA, caller: payer.publicKey })
        .rpc();

      const m: any = await (program.account as any).market.fetch(MARKET2);
      expect(m.settled).to.equal(true);
      expect(JSON.stringify(m.outcome)).to.match(/yes/i);
    });

    it("settle twice is rejected", async () => {
      try {
        await program.methods
          .settleMarket()
          .accounts({ market: MARKET2, oracle, config: CONFIG_PDA, caller: payer.publicKey })
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/already|settled/);
      }
    });

    it("redeem winning side YES: 1 USDC per token", async () => {
      const balBefore = (await getAccount(connection, u1m2.usdc)).amount;
      await program.methods
        .redeem({ yes: {} } as any, new BN(5))
        .accounts({
          market: MARKET2,
          yesMint: YES2,
          noMint: NO2,
          usdcMint,
          vault: VAULT2,
          userUsdc: u1m2.usdc,
          userYes: u1m2.yes,
          userNo: u1m2.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
      const balAfter = (await getAccount(connection, u1m2.usdc)).amount;
      expect((balAfter - balBefore).toString()).to.equal("5000000");
    });

    it("redeem losing side NO: burns for 0 USDC", async () => {
      const balBefore = (await getAccount(connection, u1m2.usdc)).amount;
      const noBefore = (await getAccount(connection, u1m2.no)).amount;
      await program.methods
        .redeem({ no: {} } as any, new BN(5))
        .accounts({
          market: MARKET2,
          yesMint: YES2,
          noMint: NO2,
          usdcMint,
          vault: VAULT2,
          userUsdc: u1m2.usdc,
          userYes: u1m2.yes,
          userNo: u1m2.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
      const balAfter = (await getAccount(connection, u1m2.usdc)).amount;
      const noAfter = (await getAccount(connection, u1m2.no)).amount;
      expect(balAfter.toString()).to.equal(balBefore.toString()); // no USDC
      expect((noBefore - noAfter).toString()).to.equal("5"); // burned 5
    });

    it("stale oracle is rejected on a separate market", async () => {
      const STRIKE3 = 30000n;
      const NEAR3 = BigInt(Math.floor(Date.now() / 1000) + 3);
      const M3 = marketPDA(TICKER, STRIKE3, NEAR3);
      const Y3 = yesMintPDA(M3);
      const N3 = noMintPDA(M3);
      const V3 = await getAssociatedTokenAddress(usdcMint, M3, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE3.toString()), new BN(NEAR3.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: M3,
          yesMint: Y3,
          noMint: N3,
          usdcMint,
          vault: V3,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Write a *stale* oracle (publish_time far in the past, vs validator clock).
      const staleSlot = await connection.getSlot();
      const staleNow = (await connection.getBlockTime(staleSlot)) ?? Math.floor(Date.now() / 1000);
      await program.methods
        .updateOracle(
          TICKER,
          new BN(30000),
          new BN(20),
          new BN(staleNow - 1000), // 1000s old → stale
          -2,
        )
        .accounts({
          config: CONFIG_PDA,
          oracleAuthority: oracleAuthority.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleAuthority])
        .rpc();

      await sleep(4000);

      try {
        await program.methods
          .settleMarket()
          .accounts({ market: M3, oracle, config: CONFIG_PDA, caller: payer.publicKey })
          .rpc();
        throw new Error("should have rejected stale");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/stale/);
      }
    });

    it("wide confidence is rejected", async () => {
      const STRIKE4 = 30000n;
      const NEAR4 = BigInt(Math.floor(Date.now() / 1000) + 3);
      const M4 = marketPDA(TICKER, STRIKE4 + 1n, NEAR4);
      const Y4 = yesMintPDA(M4);
      const N4 = noMintPDA(M4);
      const V4 = await getAssociatedTokenAddress(usdcMint, M4, true);

      await program.methods
        .createStrikeMarket(
          TICKER,
          new BN((STRIKE4 + 1n).toString()),
          new BN(NEAR4.toString()),
        )
        .accounts({
          config: CONFIG_PDA,
          market: M4,
          yesMint: Y4,
          noMint: N4,
          usdcMint,
          vault: V4,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Wide confidence: conf / price = 1000/22000 > 0.5%. Fresh publish_time
      // (validator clock) so the confidence gate — not staleness — is what fires.
      const wideSlot = await connection.getSlot();
      const wideNow = (await connection.getBlockTime(wideSlot)) ?? Math.floor(Date.now() / 1000);
      await program.methods
        .updateOracle(
          TICKER,
          new BN(22000),
          new BN(1000),
          new BN(wideNow),
          -2,
        )
        .accounts({
          config: CONFIG_PDA,
          oracleAuthority: oracleAuthority.publicKey,
          oracle,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleAuthority])
        .rpc();

      await sleep(4000);

      try {
        await program.methods
          .settleMarket()
          .accounts({ market: M4, oracle, config: CONFIG_PDA, caller: payer.publicKey })
          .rpc();
        throw new Error("should have rejected wide conf");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/confidence|wide/);
      }
    });

    it("settle ABOVE strike → YES wins; YES redeems $1/token, NO redeems $0", async () => {
      const STRIKE = 25000n; // $250.00
      const EXP = BigInt(Math.floor(Date.now() / 1000) + 4);
      const M = marketPDA(TICKER, STRIKE, EXP);
      const Y = yesMintPDA(M);
      const N = noMintPDA(M);
      const V = await getAssociatedTokenAddress(usdcMint, M, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE.toString()), new BN(EXP.toString()))
        .accounts({
          config: CONFIG_PDA, market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          oracle, payer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .rpc();

      const yAta = await getOrCreateAssociatedTokenAccount(connection, payer, Y, user1.publicKey);
      const nAta = await getOrCreateAssociatedTokenAccount(connection, payer, N, user1.publicKey);
      await program.methods
        .mintPair(new BN(10))
        .accounts({
          config: CONFIG_PDA, market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          userUsdc: user1Atas.usdc, userYes: yAta.address, userNo: nAta.address,
          user: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await sleep(Math.max(0, Number(EXP) - Math.floor(Date.now() / 1000) + 2) * 1000);

      // Close ABOVE strike (26000 > 25000) → YES wins. Stamp publish_time from
      // the validator clock — test-validator time can drift ahead of wall-clock,
      // and settle_market measures staleness against the on-chain clock.
      const aboveSlot = await connection.getSlot();
      const aboveNow = (await connection.getBlockTime(aboveSlot)) ?? Math.floor(Date.now() / 1000);
      await program.methods
        .updateOracle(TICKER, new BN(26000), new BN(20), new BN(aboveNow), -2)
        .accounts({ config: CONFIG_PDA, oracleAuthority: oracleAuthority.publicKey, oracle, systemProgram: SystemProgram.programId })
        .signers([oracleAuthority])
        .rpc();

      await program.methods
        .settleMarket()
        .accounts({ market: M, oracle, config: CONFIG_PDA, caller: payer.publicKey })
        .rpc();

      const m: any = await (program.account as any).market.fetch(M);
      expect(m.settled).to.equal(true);
      expect(JSON.stringify(m.outcome)).to.match(/yes/i);

      // Winning YES redeems $1/token.
      const beforeWin = (await getAccount(connection, user1Atas.usdc)).amount;
      await program.methods
        .redeem({ yes: {} } as any, new BN(4))
        .accounts({
          market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          userUsdc: user1Atas.usdc, userYes: yAta.address, userNo: nAta.address,
          user: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
      const afterWin = (await getAccount(connection, user1Atas.usdc)).amount;
      expect((afterWin - beforeWin).toString()).to.equal("4000000");

      // Losing NO redeems $0.
      const beforeLose = (await getAccount(connection, user1Atas.usdc)).amount;
      await program.methods
        .redeem({ no: {} } as any, new BN(4))
        .accounts({
          market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          userUsdc: user1Atas.usdc, userYes: yAta.address, userNo: nAta.address,
          user: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
      const afterLose = (await getAccount(connection, user1Atas.usdc)).amount;
      expect((afterLose - beforeLose).toString()).to.equal("0");
    });

    it("settle BELOW strike → NO wins; NO redeems $1/token, YES redeems $0", async () => {
      const STRIKE = 26000n; // $260.00
      const EXP = BigInt(Math.floor(Date.now() / 1000) + 4);
      const M = marketPDA(TICKER, STRIKE, EXP);
      const Y = yesMintPDA(M);
      const N = noMintPDA(M);
      const V = await getAssociatedTokenAddress(usdcMint, M, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE.toString()), new BN(EXP.toString()))
        .accounts({
          config: CONFIG_PDA, market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          oracle, payer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .rpc();

      const yAta = await getOrCreateAssociatedTokenAccount(connection, payer, Y, user1.publicKey);
      const nAta = await getOrCreateAssociatedTokenAccount(connection, payer, N, user1.publicKey);
      await program.methods
        .mintPair(new BN(10))
        .accounts({
          config: CONFIG_PDA, market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          userUsdc: user1Atas.usdc, userYes: yAta.address, userNo: nAta.address,
          user: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await sleep(Math.max(0, Number(EXP) - Math.floor(Date.now() / 1000) + 2) * 1000);

      // Close BELOW strike (24000 < 26000) → NO wins. Stamp publish_time from
      // the validator clock — test-validator time can drift ahead of wall-clock,
      // and settle_market measures staleness against the on-chain clock.
      const belowSlot = await connection.getSlot();
      const belowNow = (await connection.getBlockTime(belowSlot)) ?? Math.floor(Date.now() / 1000);
      await program.methods
        .updateOracle(TICKER, new BN(24000), new BN(20), new BN(belowNow), -2)
        .accounts({ config: CONFIG_PDA, oracleAuthority: oracleAuthority.publicKey, oracle, systemProgram: SystemProgram.programId })
        .signers([oracleAuthority])
        .rpc();

      await program.methods
        .settleMarket()
        .accounts({ market: M, oracle, config: CONFIG_PDA, caller: payer.publicKey })
        .rpc();

      const m: any = await (program.account as any).market.fetch(M);
      expect(m.settled).to.equal(true);
      expect(JSON.stringify(m.outcome)).to.match(/no/i);

      // Winning NO redeems $1/token.
      const beforeWin = (await getAccount(connection, user1Atas.usdc)).amount;
      await program.methods
        .redeem({ no: {} } as any, new BN(4))
        .accounts({
          market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          userUsdc: user1Atas.usdc, userYes: yAta.address, userNo: nAta.address,
          user: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
      const afterWin = (await getAccount(connection, user1Atas.usdc)).amount;
      expect((afterWin - beforeWin).toString()).to.equal("4000000");

      // Losing YES redeems $0.
      const beforeLose = (await getAccount(connection, user1Atas.usdc)).amount;
      await program.methods
        .redeem({ yes: {} } as any, new BN(4))
        .accounts({
          market: M, yesMint: Y, noMint: N, usdcMint, vault: V,
          userUsdc: user1Atas.usdc, userYes: yAta.address, userNo: nAta.address,
          user: user1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
      const afterLose = (await getAccount(connection, user1Atas.usdc)).amount;
      expect((afterLose - beforeLose).toString()).to.equal("0");
    });
  });

  describe("12. admin_settle_override", () => {
    it("admin override before 1h delay is rejected", async () => {
      const STRIKE5 = 40000n;
      const NEAR5 = BigInt(Math.floor(Date.now() / 1000) + 3);
      const M5 = marketPDA(TICKER, STRIKE5, NEAR5);
      const Y5 = yesMintPDA(M5);
      const N5 = noMintPDA(M5);
      const V5 = await getAssociatedTokenAddress(usdcMint, M5, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE5.toString()), new BN(NEAR5.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: M5,
          yesMint: Y5,
          noMint: N5,
          usdcMint,
          vault: V5,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await sleep(4000);

      try {
        await program.methods
          .adminSettleOverride(new BN(40000))
          .accounts({
            config: CONFIG_PDA,
            market: M5,
            admin: admin.publicKey,
          })
          .signers([admin])
          .rpc();
        throw new Error("should have rejected (1h delay)");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/time|gate|elapsed/);
      }
    });

    it("admin override after 1h delay succeeds (market with expiry in the deep past)", async () => {
      // Create a market with expiry_ts far in the past (e.g., 2 hours ago).
      const STRIKE6 = 50000n;
      const PAST_EXPIRY = BigInt(Math.floor(Date.now() / 1000) - 7200);
      const M6 = marketPDA(TICKER, STRIKE6, PAST_EXPIRY);
      const Y6 = yesMintPDA(M6);
      const N6 = noMintPDA(M6);
      const V6 = await getAssociatedTokenAddress(usdcMint, M6, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(STRIKE6.toString()), new BN(PAST_EXPIRY.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: M6,
          yesMint: Y6,
          noMint: N6,
          usdcMint,
          vault: V6,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .adminSettleOverride(new BN(50000))
        .accounts({
          config: CONFIG_PDA,
          market: M6,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      const m: any = await (program.account as any).market.fetch(M6);
      expect(m.settled).to.equal(true);
    });

    it("non-admin override is rejected", async () => {
      try {
        await program.methods
          .adminSettleOverride(new BN(1))
          .accounts({
            config: CONFIG_PDA,
            market: MARKET, // far-future market
            admin: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/admin|address|constraint/);
      }
    });
  });

  describe("13. add_strike (admin-gated)", () => {
    it("admin can add a fresh strike intraday", async () => {
      const STRIKE7 = 55000n;
      const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 7200);
      const M7 = marketPDA(TICKER, STRIKE7, EXPIRY);
      const Y7 = yesMintPDA(M7);
      const N7 = noMintPDA(M7);
      const V7 = await getAssociatedTokenAddress(usdcMint, M7, true);

      await program.methods
        .addStrike(TICKER, new BN(STRIKE7.toString()), new BN(EXPIRY.toString()))
        .accounts({
          config: CONFIG_PDA,
          admin: admin.publicKey,
          market: M7,
          yesMint: Y7,
          noMint: N7,
          usdcMint,
          vault: V7,
          oracle,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const m: any = await (program.account as any).market.fetch(M7);
      expect(m.strike.toString()).to.equal(STRIKE7.toString());
    });

    it("non-admin add_strike is rejected", async () => {
      const STRIKE8 = 56000n;
      const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 7200);
      const M8 = marketPDA(TICKER, STRIKE8, EXPIRY);
      const Y8 = yesMintPDA(M8);
      const N8 = noMintPDA(M8);
      const V8 = await getAssociatedTokenAddress(usdcMint, M8, true);

      try {
        await program.methods
          .addStrike(TICKER, new BN(STRIKE8.toString()), new BN(EXPIRY.toString()))
          .accounts({
            config: CONFIG_PDA,
            admin: user1.publicKey,
            market: M8,
            yesMint: Y8,
            noMint: N8,
            usdcMint,
            vault: V8,
            oracle,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/admin|address|constraint/);
      }
    });
  });

  describe("14. set_risk_params (configurable oracle thresholds)", () => {
    it("admin can configure staleness + confidence thresholds", async () => {
      await program.methods
        .setRiskParams(new BN(120), 25) // 120s staleness, 0.25% confidence
        .accounts({ config: CONFIG_PDA, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      const cfg: any = await (program.account as any).config.fetch(CONFIG_PDA);
      expect(Number(cfg.maxStalenessSecs)).to.equal(120);
      expect(Number(cfg.maxConfidenceBps)).to.equal(25);

      // Restore defaults so the threshold is back to 300s / 0.5% (50 bps).
      await program.methods
        .setRiskParams(new BN(300), 50)
        .accounts({ config: CONFIG_PDA, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      const back: any = await (program.account as any).config.fetch(CONFIG_PDA);
      expect(Number(back.maxStalenessSecs)).to.equal(300);
      expect(Number(back.maxConfidenceBps)).to.equal(50);
    });

    it("rejects invalid risk params (zero confidence bps)", async () => {
      try {
        await program.methods
          .setRiskParams(new BN(300), 0)
          .accounts({ config: CONFIG_PDA, admin: admin.publicKey })
          .signers([admin])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/risk|param|invalid/);
      }
    });

    it("non-admin set_risk_params is rejected", async () => {
      try {
        await program.methods
          .setRiskParams(new BN(300), 50)
          .accounts({ config: CONFIG_PDA, admin: user1.publicKey })
          .signers([user1])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/admin|address|constraint/);
      }
    });
  });

  // ----------------------------------------------------------------------
  // 15. Book-path position guard (assert_single_sided + place_order)
  // ----------------------------------------------------------------------
  //
  // A Bid that ACQUIRES YES while the buyer holds NO is only legal if the same
  // transaction unwinds back to single-sided (the Sell-NO flow: buy YES + redeem
  // the pair). Enforced by requiring a trailing `assert_single_sided`, which —
  // running last — reverts the tx if both sides are still held. Resting bids
  // (matched_size == 0) are exempt, so the MM can quote while holding NO.
  describe("15. book-path position guard", () => {
    const GUARD_STRIKE = 23000n;
    let GUARD_MARKET: PublicKey;
    let GUARD_YES: PublicKey;
    let GUARD_NO: PublicKey;
    let GUARD_VAULT: PublicKey;
    let takerAtas: { usdc: PublicKey; yes: PublicKey; no: PublicKey };
    let makerAtas: { usdc: PublicKey; yes: PublicKey; no: PublicKey };

    /** place_order on GUARD_MARKET (no trailing assert — like a normal taker). */
    function placeG(
      user: Keypair,
      atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey },
      cpUsdc: PublicKey,
      cpYes: PublicKey,
      side: "bid" | "ask",
      price: number,
      size: bigint,
    ) {
      return (program.methods as any)
        .placeOrder(side === "bid" ? { bid: {} } : { ask: {} }, price, new BN(size.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: GUARD_MARKET,
          orderbook: orderbookPDA(GUARD_MARKET),
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          usdcMint,
          userUsdc: atas.usdc,
          userYes: atas.yes,
          userNo: atas.no,
          counterpartyUsdc: cpUsdc,
          counterpartyYes: cpYes,
          usdcEscrow: usdcEscrowPDA(GUARD_MARKET),
          yesEscrow: yesEscrowPDA(GUARD_MARKET),
          feeDestinationUsdc: feeDestUsdc,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([user])
        .rpc();
    }

    function placeOrderIx(
      atas: { usdc: PublicKey; yes: PublicKey; no: PublicKey },
      cpUsdc: PublicKey,
      cpYes: PublicKey,
      side: "bid" | "ask",
      price: number,
      size: bigint,
      user: PublicKey,
    ) {
      return (program.methods as any)
        .placeOrder(side === "bid" ? { bid: {} } : { ask: {} }, price, new BN(size.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: GUARD_MARKET,
          orderbook: orderbookPDA(GUARD_MARKET),
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          usdcMint,
          userUsdc: atas.usdc,
          userYes: atas.yes,
          userNo: atas.no,
          counterpartyUsdc: cpUsdc,
          counterpartyYes: cpYes,
          usdcEscrow: usdcEscrowPDA(GUARD_MARKET),
          yesEscrow: yesEscrowPDA(GUARD_MARKET),
          feeDestinationUsdc: feeDestUsdc,
          user,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
    }

    function redeemPairIx(qty: bigint, user: PublicKey) {
      return (program.methods as any)
        .redeemPair(new BN(qty.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          usdcMint,
          vault: GUARD_VAULT,
          userUsdc: takerAtas.usdc,
          userYes: takerAtas.yes,
          userNo: takerAtas.no,
          user,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
    }

    function assertSingleSidedIx(user: PublicKey) {
      return (program.methods as any)
        .assertSingleSided()
        .accounts({
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          userYes: takerAtas.yes,
          userNo: takerAtas.no,
          user,
        })
        .instruction();
    }

    before(async () => {
      const EXP = BigInt(Math.floor(Date.now() / 1000) + 7200);
      GUARD_MARKET = marketPDA(TICKER, GUARD_STRIKE, EXP);
      GUARD_YES = yesMintPDA(GUARD_MARKET);
      GUARD_NO = noMintPDA(GUARD_MARKET);
      GUARD_VAULT = await getAssociatedTokenAddress(usdcMint, GUARD_MARKET, true);

      await program.methods
        .createStrikeMarket(TICKER, new BN(GUARD_STRIKE.toString()), new BN(EXP.toString()))
        .accounts({
          config: CONFIG_PDA,
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          usdcMint,
          vault: GUARD_VAULT,
          oracle,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .initMarketBooks()
        .accounts({
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          usdcMint,
          orderbook: orderbookPDA(GUARD_MARKET),
          usdcEscrow: usdcEscrowPDA(GUARD_MARKET),
          yesEscrow: yesEscrowPDA(GUARD_MARKET),
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const ty = await getOrCreateAssociatedTokenAccount(connection, payer, GUARD_YES, user1.publicKey);
      const tn = await getOrCreateAssociatedTokenAccount(connection, payer, GUARD_NO, user1.publicKey);
      const my = await getOrCreateAssociatedTokenAccount(connection, payer, GUARD_YES, user2.publicKey);
      const mn = await getOrCreateAssociatedTokenAccount(connection, payer, GUARD_NO, user2.publicKey);
      takerAtas = { usdc: user1Atas.usdc, yes: ty.address, no: tn.address };
      makerAtas = { usdc: user2Atas.usdc, yes: my.address, no: mn.address };

      // Give the taker a NO-ONLY position: mint a pair, then sell the YES leg
      // into a maker bid. Taker ends holding 20 NO, 0 YES.
      await program.methods
        .mintPair(new BN(20))
        .accounts({
          config: CONFIG_PDA,
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          usdcMint,
          vault: GUARD_VAULT,
          userUsdc: takerAtas.usdc,
          userYes: takerAtas.yes,
          userNo: takerAtas.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Maker rests a bid buying 20 YES @ 40, taker sells 20 YES into it.
      await placeG(user2, makerAtas, makerAtas.usdc, makerAtas.yes, "bid", 40, 20n);
      await placeG(user1, takerAtas, takerAtas.usdc, makerAtas.yes, "ask", 40, 20n);

      // Maker (now holding 20 YES) rests an ASK selling 20 YES @ 45.
      await placeG(user2, makerAtas, makerAtas.usdc, makerAtas.yes, "ask", 45, 20n);

      const tYes = (await getAccount(connection, takerAtas.yes)).amount;
      const tNo = (await getAccount(connection, takerAtas.no)).amount;
      expect(tYes.toString()).to.equal("0");
      expect(tNo.toString()).to.equal("20");
    });

    it("Bid acquiring YES while holding NO WITHOUT a trailing assert is rejected", async () => {
      try {
        await placeG(user1, takerAtas, makerAtas.usdc, takerAtas.yes, "bid", 45, 5n);
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/single|guard|assert/);
      }
      // Maker's ask is untouched (the failed tx reverted atomically).
      const tNo = (await getAccount(connection, takerAtas.no)).amount;
      expect(tNo.toString()).to.equal("20");
    });

    it("Sell-NO atomic tx [buy YES + redeem_pair + assert] succeeds and ends single-sided", async () => {
      const buyIx = await placeOrderIx(
        takerAtas,
        makerAtas.usdc,
        takerAtas.yes,
        "bid",
        45,
        5n,
        user1.publicKey,
      );
      const redeemIx = await redeemPairIx(5n, user1.publicKey);
      const assertIx = await assertSingleSidedIx(user1.publicKey);
      const tx = new Transaction().add(buyIx, redeemIx, assertIx);
      await provider.sendAndConfirm(tx, [user1]);

      const tYes = (await getAccount(connection, takerAtas.yes)).amount;
      const tNo = (await getAccount(connection, takerAtas.no)).amount;
      expect(tYes.toString()).to.equal("0"); // bought 5, burned 5
      expect(tNo.toString()).to.equal("15"); // redeemed 5 of 20
    });

    it("assert_single_sided passes when single-sided, fails when holding both", async () => {
      // Taker currently holds 15 NO, 0 YES → single-sided → passes.
      await program.methods
        .assertSingleSided()
        .accounts({
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          userYes: takerAtas.yes,
          userNo: takerAtas.no,
          user: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      // Mint 1 pair → now holds 1 YES + 16 NO → assert must fail.
      await program.methods
        .mintPair(new BN(1))
        .accounts({
          config: CONFIG_PDA,
          market: GUARD_MARKET,
          yesMint: GUARD_YES,
          noMint: GUARD_NO,
          usdcMint,
          vault: GUARD_VAULT,
          userUsdc: takerAtas.usdc,
          userYes: takerAtas.yes,
          userNo: takerAtas.no,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      try {
        await program.methods
          .assertSingleSided()
          .accounts({
            market: GUARD_MARKET,
            yesMint: GUARD_YES,
            noMint: GUARD_NO,
            userYes: takerAtas.yes,
            userNo: takerAtas.no,
            user: user1.publicKey,
          })
          .signers([user1])
          .rpc();
        throw new Error("should have rejected");
      } catch (e: any) {
        expect(e.toString().toLowerCase()).to.match(/both|single|sided/);
      }
    });
  });
});
