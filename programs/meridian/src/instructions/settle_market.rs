use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, Market, OracleAccount, Outcome};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(
        mut,
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_bytes(),
            &market.strike.to_le_bytes(),
            &market.expiry_ts.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = oracle,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [OracleAccount::SEED_PREFIX, market.ticker.as_bytes()],
        bump = oracle.bump,
    )]
    pub oracle: Box<Account<'info, OracleAccount>>,

    /// Global config — supplies the CONFIGURABLE staleness + confidence
    /// thresholds (admin-tunable via `set_risk_params`).
    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    pub caller: Signer<'info>,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub outcome: u8, // 0 = Yes, 1 = No
    pub settlement_price_cents: u64,
    pub strike_cents: u64,
    pub settlement_ts: i64,
}

pub fn handler(ctx: Context<SettleMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let oracle = &ctx.accounts.oracle;
    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    require!(!market.settled, MeridianError::AlreadySettled);
    require!(
        clock.unix_timestamp >= market.expiry_ts,
        MeridianError::TimeGateNotElapsed
    );

    // Staleness: oracle.publish_time must be within the CONFIGURABLE
    // config.max_staleness_secs of the current time.
    let age = clock
        .unix_timestamp
        .checked_sub(oracle.publish_time)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        age >= 0 && age <= config.max_staleness_secs,
        MeridianError::OraclesStale
    );

    // Price must be non-negative.
    require!(oracle.price >= 0, MeridianError::OracleNegativePrice);
    let price_abs = oracle.price as u128;

    // Confidence: conf / |price| <= config.max_confidence_bps / 10_000
    // i.e. conf * 10_000 <= |price| * max_confidence_bps   (CONFIGURABLE).
    let conf_check = (oracle.conf as u128)
        .checked_mul(10_000)
        .ok_or(MeridianError::MathOverflow)?;
    let price_check = price_abs
        .checked_mul(config.max_confidence_bps as u128)
        .ok_or(MeridianError::MathOverflow)?;
    require!(conf_check <= price_check, MeridianError::OracleConfidenceWide);

    // Convert oracle.price (with oracle.expo) into cents (u64).
    let settlement_price_cents = price_to_cents(oracle.price, oracle.expo)?;

    let outcome = if settlement_price_cents >= market.strike {
        Outcome::Yes
    } else {
        Outcome::No
    };

    market.settled = true;
    market.outcome = Some(outcome);
    market.settlement_ts = Some(clock.unix_timestamp);
    market.settlement_price = Some(settlement_price_cents);

    emit!(MarketSettled {
        market: market.key(),
        outcome: match outcome {
            Outcome::Yes => 0,
            Outcome::No => 1,
        },
        settlement_price_cents,
        strike_cents: market.strike,
        settlement_ts: clock.unix_timestamp,
    });

    Ok(())
}

/// Convert a Pyth-style (price, expo) pair into integer cents.
/// Cents = price * 10^(expo + 2). If expo + 2 >= 0 we scale up; otherwise scale down.
/// Returns an error on overflow or on a negative price.
pub fn price_to_cents(price: i64, expo: i32) -> Result<u64> {
    require!(price >= 0, MeridianError::OracleNegativePrice);
    let mut p: i128 = price as i128;
    let shift = (expo as i64) + 2; // we want price * 10^(expo + 2) = cents
    if shift >= 0 {
        for _ in 0..shift {
            p = p.checked_mul(10).ok_or(MeridianError::MathOverflow)?;
        }
    } else {
        for _ in 0..(-shift) {
            p /= 10;
        }
    }
    require!(p >= 0, MeridianError::OracleNegativePrice);
    let cents: u64 = u64::try_from(p).map_err(|_| MeridianError::MathOverflow)?;
    Ok(cents)
}
