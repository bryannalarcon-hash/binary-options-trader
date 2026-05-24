use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::instructions::place_order::OrderSide;
use crate::state::{Market, Order, OrderBook, ORDERBOOK_DEPTH};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
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

    #[account(
        mut,
        seeds = [OrderBook::SEED_PREFIX, market.key().as_ref()],
        bump,
    )]
    pub orderbook: AccountLoader<'info, OrderBook>,

    #[account(address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(address = market.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"usdc_escrow", market.key().as_ref()],
        bump,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"yes_escrow", market.key().as_ref()],
        bump,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct OrderCancelled {
    pub user: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub index: u8,
    pub returned_size: u64,
    pub returned_price: u16,
}

pub fn handler(ctx: Context<CancelOrder>, side: OrderSide, index: u8) -> Result<()> {
    require!(
        (index as usize) < ORDERBOOK_DEPTH,
        MeridianError::InvalidOrderIndex
    );

    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    // Phase 1: read order
    let (order_owner, order_price, order_size, is_empty) = {
        let ob = ctx.accounts.orderbook.load()?;
        let o = match side {
            OrderSide::Bid => ob.bids[index as usize],
            OrderSide::Ask => ob.asks[index as usize],
        };
        (o.owner, o.price, o.size, o.is_empty())
    };
    require!(!is_empty, MeridianError::OrderNotFound);
    require!(order_owner == user_key, MeridianError::NotOrderOwner);

    // Build market PDA signer for escrow release.
    let ticker_bytes = ctx.accounts.market.ticker.as_bytes().to_vec();
    let strike_bytes = ctx.accounts.market.strike.to_le_bytes();
    let expiry_bytes = ctx.accounts.market.expiry_ts.to_le_bytes();
    let market_bump = [ctx.accounts.market.bump];
    let market_signer: &[&[u8]] = &[
        Market::SEED_PREFIX,
        &ticker_bytes,
        &strike_bytes,
        &expiry_bytes,
        &market_bump,
    ];
    let market_signers = &[market_signer];

    match side {
        OrderSide::Bid => {
            let usdc_amount = (order_size as u128)
                .checked_mul(order_price as u128)
                .and_then(|v| v.checked_mul(10_000u128))
                .ok_or(MeridianError::MathOverflow)?;
            let usdc_amount: u64 = usdc_amount
                .try_into()
                .map_err(|_| MeridianError::MathOverflow)?;

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.usdc_escrow.to_account_info(),
                        to: ctx.accounts.user_usdc.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    market_signers,
                ),
                usdc_amount,
            )?;

            let mut ob = ctx.accounts.orderbook.load_mut()?;
            ob.bids[index as usize] = Order::default();
        }
        OrderSide::Ask => {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.yes_escrow.to_account_info(),
                        to: ctx.accounts.user_yes.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    market_signers,
                ),
                order_size,
            )?;

            let mut ob = ctx.accounts.orderbook.load_mut()?;
            ob.asks[index as usize] = Order::default();
        }
    }

    emit!(OrderCancelled {
        user: user_key,
        market: market_key,
        side: match side {
            OrderSide::Bid => 0,
            OrderSide::Ask => 1,
        },
        index,
        returned_size: order_size,
        returned_price: order_price,
    });

    Ok(())
}
