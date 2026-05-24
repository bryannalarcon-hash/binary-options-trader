use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{Market, OrderBook};

/// One-shot initialization of the order book + bid/ask escrows for a market.
///
/// This is a separate instruction from `create_strike_market` because the
/// combined `init` set otherwise blows the 4 KB BPF stack frame on the
/// per-strike create call. The frontend (and automation service) call this
/// once, immediately after `create_strike_market`, in the same transaction.
#[derive(Accounts)]
pub struct InitMarketBooks<'info> {
    #[account(
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_bytes(),
            &market.strike.to_le_bytes(),
            &market.expiry_ts.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = yes_mint,
        has_one = usdc_mint,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(address = market.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        space = 8 + OrderBook::SIZE,
        seeds = [OrderBook::SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub orderbook: AccountLoader<'info, OrderBook>,

    #[account(
        init,
        payer = payer,
        seeds = [b"usdc_escrow", market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [b"yes_escrow", market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = market,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitMarketBooks>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let mut ob = ctx.accounts.orderbook.load_init()?;
    ob.market = market_key;
    ob.bump = ctx.bumps.orderbook;
    Ok(())
}
