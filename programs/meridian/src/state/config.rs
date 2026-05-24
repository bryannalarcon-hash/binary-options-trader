use anchor_lang::prelude::*;

/// Global configuration account (singleton PDA: seeds = ["config"]).
///
/// Holds admin authority, fee destination, pause flag, and the oracle
/// authority pubkey allowed to write mock-price accounts on localnet.
#[account]
#[derive(InitSpace, Debug)]
pub struct Config {
    /// Admin authority — can pause, add strikes, run admin_settle_override.
    pub admin: Pubkey,

    /// Fee destination — receives protocol fees (separate from market vaults).
    pub fee_destination: Pubkey,

    /// Oracle authority — the only signer allowed to call `update_oracle`.
    /// On localnet this is the automation wallet writing scripted prices.
    pub oracle_authority: Pubkey,

    /// USDC mint used as collateral across all markets.
    pub usdc_mint: Pubkey,

    /// Global pause flag — when true, mint_pair / place_order / redeem all halt.
    pub paused: bool,

    /// PDA bump for the config account itself.
    pub bump: u8,
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";
}
