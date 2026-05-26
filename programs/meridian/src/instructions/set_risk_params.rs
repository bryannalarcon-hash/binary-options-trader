use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::Config;

/// Admin-only: tune the settlement risk thresholds (oracle staleness window +
/// confidence band). This makes the staleness/confidence checks CONFIGURABLE at
/// runtime rather than hardcoded constants.
#[derive(Accounts)]
pub struct SetRiskParams<'info> {
    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(address = config.admin @ MeridianError::AdminRequired)]
    pub admin: Signer<'info>,
}

#[event]
pub struct RiskParamsUpdated {
    pub admin: Pubkey,
    pub max_staleness_secs: i64,
    pub max_confidence_bps: u16,
}

pub fn handler(
    ctx: Context<SetRiskParams>,
    max_staleness_secs: i64,
    max_confidence_bps: u16,
) -> Result<()> {
    require!(max_staleness_secs > 0, MeridianError::InvalidRiskParam);
    require!(
        max_confidence_bps > 0 && max_confidence_bps <= 10_000,
        MeridianError::InvalidRiskParam
    );

    let cfg = &mut ctx.accounts.config;
    cfg.max_staleness_secs = max_staleness_secs;
    cfg.max_confidence_bps = max_confidence_bps;

    emit!(RiskParamsUpdated {
        admin: ctx.accounts.admin.key(),
        max_staleness_secs,
        max_confidence_bps,
    });
    msg!(
        "risk params updated: max_staleness_secs={}, max_confidence_bps={}",
        max_staleness_secs,
        max_confidence_bps
    );
    Ok(())
}
