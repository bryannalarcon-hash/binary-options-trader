use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::MeridianError;
use crate::state::Config;

/// One-time migration to grow a pre-existing `Config` account from the original
/// layout (no risk-param fields) to the current layout, setting the two new
/// fields (`max_staleness_secs`, `max_confidence_bps`) to their defaults.
///
/// Needed for an in-place program upgrade on a cluster whose `Config` was
/// created before those fields existed: a regular `Account<Config>` would fail
/// to deserialize the shorter account, so we touch it as a raw `UncheckedAccount`
/// and `realloc` it. Admin-gated (the on-chain admin lives at bytes `[8..40]`)
/// and idempotent (a no-op once the account is already at the new size).
#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    /// CHECK: migrated as a raw account because the on-chain layout predates the
    /// risk-param fields; validated by PDA seeds + owner + the embedded admin.
    #[account(mut, seeds = [Config::SEED_PREFIX], bump)]
    pub config: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// Original layout: disc(8) + admin(32) + fee_destination(32) + oracle_authority(32)
// + usdc_mint(32) + paused(1) + bump(1) = 138 bytes. The two new fields are
// appended: max_staleness_secs (i64) at [138..146], max_confidence_bps (u16) at
// [146..148].
const OLD_LEN: usize = 138;
const STALENESS_OFFSET: usize = 138;
const CONFIDENCE_OFFSET: usize = 146;

pub fn handler(ctx: Context<MigrateConfig>) -> Result<()> {
    let config = &ctx.accounts.config;
    let new_len = 8 + Config::INIT_SPACE;

    require_keys_eq!(*config.owner, crate::ID, MeridianError::InvalidConfigLayout);

    {
        let data = config.try_borrow_data()?;
        require!(data.len() >= OLD_LEN, MeridianError::InvalidConfigLayout);
        let admin_bytes: [u8; 32] = data[8..40].try_into().unwrap();
        require_keys_eq!(
            Pubkey::new_from_array(admin_bytes),
            ctx.accounts.admin.key(),
            MeridianError::AdminRequired
        );
        if data.len() >= new_len {
            return Ok(()); // already migrated — idempotent
        }
    }

    // Keep the account rent-exempt at the larger size.
    let rent = Rent::get()?;
    let needed = rent.minimum_balance(new_len);
    let current = config.lamports();
    if needed > current {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: config.to_account_info(),
                },
            ),
            needed - current,
        )?;
    }

    config.realloc(new_len, false)?;

    let mut data = config.try_borrow_mut_data()?;
    data[STALENESS_OFFSET..STALENESS_OFFSET + 8]
        .copy_from_slice(&Config::DEFAULT_MAX_STALENESS_SECS.to_le_bytes());
    data[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 2]
        .copy_from_slice(&Config::DEFAULT_MAX_CONFIDENCE_BPS.to_le_bytes());

    msg!("migrated Config to {} bytes (risk params set to defaults)", new_len);
    Ok(())
}
