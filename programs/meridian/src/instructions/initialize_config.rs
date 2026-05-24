use anchor_lang::prelude::*;

use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub fee_destination: Pubkey,
    pub oracle_authority: Pubkey,
    pub usdc_mint: Pubkey,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    admin: Pubkey,
    fee_destination: Pubkey,
    oracle_authority: Pubkey,
    usdc_mint: Pubkey,
) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.admin = admin;
    cfg.fee_destination = fee_destination;
    cfg.oracle_authority = oracle_authority;
    cfg.usdc_mint = usdc_mint;
    cfg.paused = false;
    cfg.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        admin,
        fee_destination,
        oracle_authority,
        usdc_mint,
    });

    msg!(
        "Meridian config initialized — admin: {}, fee_dest: {}, usdc_mint: {}",
        admin,
        fee_destination,
        usdc_mint
    );
    Ok(())
}
