//! Meridian — binary options prediction market on Solana.
//!
//! Sixteen instructions; see `instructions/*.rs` for full handlers.

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod pdas;
pub mod state;

use instructions::*;

declare_id!("DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19");

#[program]
pub mod meridian {
    use super::*;

    // -------- Lifecycle / admin --------

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        admin: Pubkey,
        fee_destination: Pubkey,
        oracle_authority: Pubkey,
        usdc_mint: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::handler(
            ctx,
            admin,
            fee_destination,
            oracle_authority,
            usdc_mint,
        )
    }

    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        ticker: String,
        strike: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        instructions::create_strike_market::handler(ctx, ticker, strike, expiry_ts)
    }

    /// One-shot init of the order book + bid/ask escrows. Must be called once
    /// per market, immediately after `create_strike_market`. Split out because
    /// the combined `init` set otherwise blows the BPF 4 KB stack frame.
    pub fn init_market_books(ctx: Context<InitMarketBooks>) -> Result<()> {
        instructions::init_market_books::handler(ctx)
    }

    pub fn add_strike(
        ctx: Context<AddStrike>,
        ticker: String,
        strike: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        instructions::add_strike::handler(ctx, ticker, strike, expiry_ts)
    }

    pub fn pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        instructions::pause::handler(ctx, paused)
    }

    /// Admin: tune the CONFIGURABLE settlement risk thresholds (oracle
    /// staleness window in seconds + confidence band in basis points).
    pub fn set_risk_params(
        ctx: Context<SetRiskParams>,
        max_staleness_secs: i64,
        max_confidence_bps: u16,
    ) -> Result<()> {
        instructions::set_risk_params::handler(ctx, max_staleness_secs, max_confidence_bps)
    }

    // -------- Token operations --------

    pub fn mint_pair(ctx: Context<MintPair>, amount_pairs: u64) -> Result<()> {
        instructions::mint_pair::handler(ctx, amount_pairs)
    }

    pub fn redeem_pair(ctx: Context<RedeemPair>, amount_pairs: u64) -> Result<()> {
        instructions::redeem_pair::handler(ctx, amount_pairs)
    }

    pub fn redeem(ctx: Context<Redeem>, side: TokenSide, amount: u64) -> Result<()> {
        instructions::redeem::handler(ctx, side, amount)
    }

    // -------- Order book --------

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: OrderSide,
        price: u16,
        size: u64,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, side, price, size)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, side: OrderSide, index: u8) -> Result<()> {
        instructions::cancel_order::handler(ctx, side, index)
    }

    /// Position-constraint guard. Reverts if the signer holds both YES and NO
    /// for `market`. `place_order` requires this to appear later in the same
    /// transaction when a Bid acquires YES while the buyer holds NO, so a
    /// both-sides state can never persist past a tx boundary on the book path.
    pub fn assert_single_sided(ctx: Context<AssertSingleSided>) -> Result<()> {
        instructions::assert_single_sided::handler(ctx)
    }

    // -------- Settlement / oracle --------

    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::handler(ctx)
    }

    pub fn admin_settle_override(
        ctx: Context<AdminSettleOverride>,
        manual_price: u64,
    ) -> Result<()> {
        instructions::admin_settle_override::handler(ctx, manual_price)
    }

    pub fn update_oracle(
        ctx: Context<UpdateOracle>,
        ticker: String,
        price: i64,
        conf: u64,
        publish_time: i64,
        expo: i32,
    ) -> Result<()> {
        instructions::update_oracle::handler(ctx, ticker, price, conf, publish_time, expo)
    }

    /// Recovery: close a bricked oracle PDA (legacy `MockOracle` discriminator)
    /// so `update_oracle` can re-create it with the current discriminator.
    pub fn close_oracle(ctx: Context<CloseOracle>, ticker: String) -> Result<()> {
        instructions::close_oracle::handler(ctx, ticker)
    }
}
