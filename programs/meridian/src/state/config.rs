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

    /// Global pause flag — when true, mint_pair and place_order halt. redeem /
    /// redeem_pair stay live by design so holders can always exit and claim
    /// settled winnings even while new entries are paused.
    pub paused: bool,

    /// PDA bump for the config account itself.
    pub bump: u8,

    /// Max oracle staleness (seconds) accepted at settlement. CONFIGURABLE by
    /// the admin via `set_risk_params`. Default 300 (5 min).
    pub max_staleness_secs: i64,

    /// Max oracle confidence band as basis points of |price| (conf/|price|).
    /// e.g. 50 = 0.5%. CONFIGURABLE by the admin via `set_risk_params`.
    pub max_confidence_bps: u16,
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";

    /// Default settlement risk thresholds (set at initialize_config; admin can
    /// later tune them with `set_risk_params`).
    pub const DEFAULT_MAX_STALENESS_SECS: i64 = 300;
    pub const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 50; // 0.5%
}
