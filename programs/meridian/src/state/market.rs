use anchor_lang::prelude::*;

/// Maximum ticker length — covers MAG7 plus headroom for future symbols.
pub const MAX_TICKER_LEN: usize = 8;

/// Binary settlement outcome.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    /// Underlying closed at-or-above strike → YES wins.
    Yes,
    /// Underlying closed below strike → NO wins.
    No,
}

/// Per-strike market account.
///
/// PDA: seeds = ["market", ticker_bytes, strike_le, expiry_ts_le].
///
/// The Market PDA itself is the authority for `yes_mint`, `no_mint`, and `vault`.
/// This keeps the account graph small and matches the canonical T-SC-04 contract.
#[account]
#[derive(InitSpace, Debug)]
pub struct Market {
    /// ASCII ticker symbol (e.g. "AAPL"). Stored fixed-length, padded.
    #[max_len(MAX_TICKER_LEN)]
    pub ticker: String,

    /// Strike price in USD cents (e.g. 22000 = $220.00).
    pub strike: u64,

    /// Unix timestamp (seconds) at which the market expires / can settle.
    pub expiry_ts: i64,

    /// YES SPL mint (PDA — authority is `market`).
    pub yes_mint: Pubkey,

    /// NO SPL mint (PDA — authority is `market`).
    pub no_mint: Pubkey,

    /// USDC vault token account (owner is `market`).
    pub vault: Pubkey,

    /// USDC mint used for collateral.
    pub usdc_mint: Pubkey,

    /// Mock oracle account (Pyth shape on localnet).
    pub oracle: Pubkey,

    /// Whether settle_market or admin_settle_override has fired.
    pub settled: bool,

    /// Settlement outcome (only meaningful when `settled == true`).
    pub outcome: Option<Outcome>,

    /// Unix timestamp at which settlement occurred.
    pub settlement_ts: Option<i64>,

    /// Recorded close price (cents) at settlement — for transparency/audit.
    pub settlement_price: Option<u64>,

    /// Total pairs minted (invariant: vault USDC balance == this * 10^6).
    pub total_pairs_minted: u64,

    /// PDA bump for the market account.
    pub bump: u8,
}

impl Market {
    pub const SEED_PREFIX: &'static [u8] = b"market";
}
