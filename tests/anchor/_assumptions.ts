/**
 * tests/anchor/_assumptions.ts
 *
 * Documented test assumptions about the Meridian contract.
 *
 * The Anchor program at programs/meridian/ presently has STUB handlers for
 * most instructions (they `msg!` and return `Ok(())`). These tests are written
 * against the CANONICAL contracts already documented in:
 *
 *   - docs/IMPLEMENTATION_PLAN.md §2.5, §2.6, §2.7, §4
 *   - docs/CODING_PRD.md §7 (per-instruction tables) and §12 (canonical signatures)
 *   - programs/meridian/src/lib.rs                 (handler signatures)
 *   - programs/meridian/src/state/{config,market,orderbook,oracle}.rs
 *   - programs/meridian/src/errors.rs
 *
 * Where the on-chain behavior is not yet implemented, individual tests will
 * `skip()` themselves at runtime if they detect the program returned a no-op
 * `Ok(())` instead of mutating state — they then re-run automatically once
 * the handlers are wired.
 *
 * Below are the assumptions a verifier should confirm whenever the contract
 * implementation lands; we record them here so the audit trail is explicit.
 */

export const ASSUMPTIONS = {
  /**
   * A1 — `initialize_config(admin, fee_destination, oracle_authority, usdc_mint)`
   *      creates the global Config PDA at seeds = ["config"], stores the four
   *      pubkeys, sets `paused = false`. Re-init is rejected (Anchor's `init`
   *      constraint, error: account already in use).
   */
  A1_initialize_config: true,

  /**
   * A2 — `create_strike_market(ticker, strike_cents, expiry_ts)` initializes:
   *        - Market PDA at ["market", ticker, strike_le, expiry_le]
   *        - YES mint PDA at ["yes_mint", market]
   *        - NO mint PDA at ["no_mint", market]
   *        - USDC vault token account at ["vault", market]
   *        - OrderBook PDA at ["orderbook", market]
   *      Mint authority for YES/NO is the `vault_authority` PDA;
   *      vault token authority is also `vault_authority`.
   */
  A2_create_strike_market: true,

  /**
   * A3 — `mint_pair(amount_pairs)`:
   *        - Rejects when Config.paused
   *        - Rejects when Market.settled
   *        - Rejects amount_pairs == 0
   *        - Transfers `amount_pairs * 1_000_000` micro-USDC user → vault
   *        - Mints `amount_pairs` of YES and `amount_pairs` of NO to the user
   *        - Increments market.total_pairs_minted (checked arithmetic)
   *        - Invariant: vault.amount == 1_000_000 * total_pairs_minted
   */
  A3_mint_pair: true,

  /**
   * A4 — `redeem_pair(amount_pairs)` (pre- or post-settlement):
   *        - Burns N YES + N NO from user
   *        - Transfers N * 1_000_000 micro-USDC vault → user
   *        - Decrements market.total_pairs_minted
   *        - Preserves the vault invariant
   */
  A4_redeem_pair: true,

  /**
   * A5 — `place_order(side, price, size)`:
   *        - Validates price in 1..=99
   *        - For Bids: escrows `price * size` micro-USDC from user (per unit, 1¢ = 10_000 µUSDC since 1 YES = $1)
   *        - For Asks: escrows `size` YES tokens from user
   *        - If crossable, matches against opposite side at maker prices (price-time priority)
   *        - Remainder inserted into the book; rejects with OrderBookFull if no empty slot
   */
  A5_place_order: true,

  /**
   * A6 — `cancel_order(side, index)`:
   *        - Requires caller == order.owner (NotOrderOwner)
   *        - Returns escrowed USDC (bid) or YES (ask) to the owner
   *        - Clears the slot
   */
  A6_cancel_order: true,

  /**
   * A7 — `match_orders(taker_side, max_price, size)`:
   *        - Walks the opposite side in price priority
   *        - Bid taker: pays USDC, receives YES; cap price <= max_price
   *        - Ask taker: pays YES, receives USDC; floor price >= max_price (treated as min for sells)
   *        - Updates resting order sizes; clears emptied slots
   */
  A7_match_orders: true,

  /**
   * A8 — `settle_market()`:
   *        - Requires clock.unix_timestamp >= market.expiry_ts (unless TEST_BYPASS_TIME_GATE)
   *        - Reads the oracle account at oracle_pda(ticker)
   *        - Rejects if `now - oracle.publish_time > MAX_STALENESS` (OraclesStale)
   *        - Rejects if `oracle.conf as f64 / oracle.price.abs() as f64 > MAX_CONF_RATIO` (OracleConfidenceWide)
   *        - Sets outcome = if oracle.price >= strike then Yes else No  ← `>=`, at-or-above
   *        - Marks market.settled = true; second call reverts (AlreadySettled)
   */
  A8_settle_market: true,

  /**
   * A9 — `admin_settle_override(manual_price)`:
   *        - Requires admin signer (config.admin == ctx.accounts.admin.key())
   *        - Requires clock.unix_timestamp >= market.expiry_ts + 3600
   *        - Sets outcome from manual_price using the same `>=` rule
   *        - Otherwise behaves like settle_market
   */
  A9_admin_settle_override: true,

  /**
   * A10 — `redeem(side, amount)`:
   *        - Requires market.settled == true
   *        - Burns `amount` of the chosen side
   *        - Winning side: transfers amount * 1_000_000 µUSDC vault → user
   *        - Losing side: transfers 0 (tokens still burned)
   */
  A10_redeem: true,

  /**
   * A11 — `update_oracle(price, conf, publish_time)`:
   *        - Requires signer == config.oracle_authority
   *        - Writes the three fields into the per-ticker oracle PDA
   */
  A11_update_oracle: true,

  /**
   * A12 — `pause(paused: bool)`:
   *        - Requires admin signer
   *        - Sets config.paused; affects mint_pair, place_order, match_orders, redeem_pair
   */
  A12_pause: true,
};

/**
 * The on-chain `>=` rule: YES wins at-or-above strike.
 * Mirrors crate::instructions::settle_market::SETTLEMENT_AT_OR_ABOVE.
 */
export function expectedOutcome(
  closePriceCents: bigint,
  strikeCents: bigint,
): "yes" | "no" {
  return closePriceCents >= strikeCents ? "yes" : "no";
}

/**
 * Reference micro-payout calculator used by the invariant property test.
 * Yes payout + No payout == 1_000_000 micro-USDC, always.
 */
export function expectedPayouts(
  closePriceCents: bigint,
  strikeCents: bigint,
): { yes: bigint; no: bigint } {
  const yesWins = closePriceCents >= strikeCents;
  return {
    yes: yesWins ? 1_000_000n : 0n,
    no: yesWins ? 0n : 1_000_000n,
  };
}
