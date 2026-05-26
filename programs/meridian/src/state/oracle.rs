use anchor_lang::prelude::*;

use super::market::MAX_TICKER_LEN;

/// On-chain oracle account — holds the latest Pyth-sourced price for a ticker,
/// written by the oracle authority. Mirrors Pyth's `PriceUpdateV2` essentials.
///
/// The automation service pulls live prices from Pyth Hermes and writes them
/// into this account via `update_oracle`. The on-chain `settle_market`
/// instruction reads `price`, `conf`, `publish_time`, `expo` exactly as it
/// would for a Pyth pull oracle.
///
/// PDA: seeds = ["oracle", ticker_bytes].
#[account]
#[derive(InitSpace, Debug)]
pub struct OracleAccount {
    /// ASCII ticker (matches the market's ticker).
    #[max_len(MAX_TICKER_LEN)]
    pub ticker: String,

    /// Price in raw oracle units (apply `expo` to interpret). i64 to match Pyth.
    pub price: i64,

    /// Confidence interval, in the same units as `price`.
    pub conf: u64,

    /// Unix timestamp (seconds) at which `price` was written.
    pub publish_time: i64,

    /// Decimal exponent (Pyth convention: actual = price * 10^expo).
    /// For prices in cents we use expo = -2 (e.g. price=23000, expo=-2 → $230.00).
    pub expo: i32,

    /// Pubkey of the oracle authority that wrote this update.
    pub last_writer: Pubkey,

    /// PDA bump.
    pub bump: u8,
}

impl OracleAccount {
    pub const SEED_PREFIX: &'static [u8] = b"oracle";
}
