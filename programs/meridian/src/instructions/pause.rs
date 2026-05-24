use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetPause<'info> {
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
pub struct Paused {
    pub admin: Pubkey,
}

#[event]
pub struct Unpaused {
    pub admin: Pubkey,
}

pub fn handler(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    if paused {
        emit!(Paused {
            admin: ctx.accounts.admin.key()
        });
    } else {
        emit!(Unpaused {
            admin: ctx.accounts.admin.key()
        });
    }
    msg!("pause set to {}", paused);
    Ok(())
}
