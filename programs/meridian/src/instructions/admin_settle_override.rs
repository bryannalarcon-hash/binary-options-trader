use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, Market, Outcome};

/// Mandatory 1-hour delay (seconds) after expiry before admin can override.
pub const ADMIN_OVERRIDE_DELAY_SECS: i64 = 3600;

#[derive(Accounts)]
pub struct AdminSettleOverride<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_bytes(),
            &market.strike.to_le_bytes(),
            &market.expiry_ts.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = config.admin @ MeridianError::AdminRequired)]
    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminSettleOverride>, manual_price: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    require!(!market.settled, MeridianError::AlreadySettled);

    let deadline = market
        .expiry_ts
        .checked_add(ADMIN_OVERRIDE_DELAY_SECS)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        clock.unix_timestamp >= deadline,
        MeridianError::TimeGateNotElapsed
    );

    let outcome = if manual_price >= market.strike {
        Outcome::Yes
    } else {
        Outcome::No
    };

    market.settled = true;
    market.outcome = Some(outcome);
    market.settlement_ts = Some(clock.unix_timestamp);
    market.settlement_price = Some(manual_price);

    emit!(crate::instructions::settle_market::MarketSettled {
        market: market.key(),
        outcome: match outcome {
            Outcome::Yes => 0,
            Outcome::No => 1,
        },
        settlement_price_cents: manual_price,
        strike_cents: market.strike,
        settlement_ts: clock.unix_timestamp,
    });

    msg!(
        "admin_settle_override: manual_price={} outcome={:?}",
        manual_price,
        outcome
    );
    Ok(())
}
