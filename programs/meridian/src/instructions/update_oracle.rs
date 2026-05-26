use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, OracleAccount, MAX_TICKER_LEN};

/// Update (or init-on-first-use) the oracle PDA for a ticker.
///
/// PDA seeds: `["oracle", ticker_bytes]`.
///
/// Authority: only `Config.oracle_authority` may sign this instruction.
#[derive(Accounts)]
#[instruction(ticker: String)]
pub struct UpdateOracle<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Oracle authority — must match `Config.oracle_authority`.
    #[account(mut, address = config.oracle_authority @ MeridianError::InvalidOracleAuthority)]
    pub oracle_authority: Signer<'info>,

    #[account(
        init_if_needed,
        payer = oracle_authority,
        space = 8 + OracleAccount::INIT_SPACE,
        seeds = [OracleAccount::SEED_PREFIX, ticker.as_bytes()],
        bump,
    )]
    pub oracle: Box<Account<'info, OracleAccount>>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct OracleUpdated {
    pub ticker: String,
    pub price: i64,
    pub conf: u64,
    pub publish_time: i64,
    pub expo: i32,
}

pub fn handler(
    ctx: Context<UpdateOracle>,
    ticker: String,
    price: i64,
    conf: u64,
    publish_time: i64,
    expo: i32,
) -> Result<()> {
    require!(
        !ticker.is_empty() && ticker.len() <= MAX_TICKER_LEN,
        MeridianError::InvalidTicker
    );

    let oracle = &mut ctx.accounts.oracle;
    // On first init, set ticker + bump; on subsequent updates, leave untouched.
    if oracle.ticker.is_empty() {
        oracle.ticker = ticker.clone();
        oracle.bump = ctx.bumps.oracle;
    } else {
        require!(oracle.ticker == ticker, MeridianError::InvalidTicker);
    }

    oracle.price = price;
    oracle.conf = conf;
    oracle.publish_time = publish_time;
    oracle.expo = expo;
    oracle.last_writer = ctx.accounts.oracle_authority.key();

    emit!(OracleUpdated {
        ticker,
        price,
        conf,
        publish_time,
        expo,
    });

    Ok(())
}
