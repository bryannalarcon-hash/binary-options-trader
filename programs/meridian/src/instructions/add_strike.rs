use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::errors::MeridianError;
use crate::instructions::create_strike_market::create_pda_mint;
use crate::state::{Config, Market, OracleAccount, MAX_TICKER_LEN};

/// Admin-gated intraday strike addition. Same account layout as
/// `create_strike_market` but requires the admin to sign.
#[derive(Accounts)]
#[instruction(ticker: String, strike: u64, expiry_ts: i64)]
pub struct AddStrike<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        address = config.admin @ MeridianError::AdminRequired,
    )]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [
            Market::SEED_PREFIX,
            ticker.as_bytes(),
            &strike.to_le_bytes(),
            &expiry_ts.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: created + initialized via `invoke_signed` in the handler.
    #[account(
        mut,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: UncheckedAccount<'info>,

    /// CHECK: created + initialized via `invoke_signed` in the handler.
    #[account(
        mut,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: UncheckedAccount<'info>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [OracleAccount::SEED_PREFIX, ticker.as_bytes()],
        bump = oracle.bump,
    )]
    pub oracle: Box<Account<'info, OracleAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<AddStrike>,
    ticker: String,
    strike: u64,
    expiry_ts: i64,
) -> Result<()> {
    require!(
        !ticker.is_empty() && ticker.len() <= MAX_TICKER_LEN,
        MeridianError::InvalidTicker
    );
    require!(strike > 0, MeridianError::InvalidStrike);
    require!(expiry_ts > 0, MeridianError::TimeGateNotElapsed);

    let market_key = ctx.accounts.market.key();
    let market_bump = ctx.bumps.market;
    let yes_bump = ctx.bumps.yes_mint;
    let no_bump = ctx.bumps.no_mint;

    create_pda_mint(
        ctx.accounts.admin.to_account_info(),
        ctx.accounts.yes_mint.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        &[b"yes_mint", market_key.as_ref(), &[yes_bump]],
        &market_key,
    )?;

    create_pda_mint(
        ctx.accounts.admin.to_account_info(),
        ctx.accounts.no_mint.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        &[b"no_mint", market_key.as_ref(), &[no_bump]],
        &market_key,
    )?;

    let market = &mut ctx.accounts.market;
    market.ticker = ticker.clone();
    market.strike = strike;
    market.expiry_ts = expiry_ts;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.usdc_mint = ctx.accounts.usdc_mint.key();
    market.oracle = ctx.accounts.oracle.key();
    market.settled = false;
    market.outcome = None;
    market.settlement_ts = None;
    market.settlement_price = None;
    market.total_pairs_minted = 0;
    market.bump = market_bump;

    msg!(
        "add_strike: ticker={} strike={} expiry={}",
        ticker,
        strike,
        expiry_ts
    );
    Ok(())
}
