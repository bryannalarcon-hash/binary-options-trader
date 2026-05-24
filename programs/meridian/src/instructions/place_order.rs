use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{Config, Market, Order, OrderBook};

/// Side selector for the in-contract CLOB.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderSide {
    /// Buying YES (locks USDC).
    Bid,
    /// Selling YES (locks YES tokens).
    Ask,
}

/// Place a limit order on the YES/USDC CLOB.
///
/// `price` is in cents (1..=99). `size` is in YES tokens.
///
/// Match-on-place: walks the opposite side and fills against AT MOST ONE
/// best counterparty (call again to sweep deeper levels). Remainder rests
/// on the book and corresponding escrow is debited from the user's wallet.
#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

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

    /// Taker's USDC token account.
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// Taker's YES token account.
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// Counterparty's USDC token account (used when matching against an ask).
    /// Pass user_usdc as a placeholder when not used.
    #[account(mut, token::mint = usdc_mint)]
    pub counterparty_usdc: Box<Account<'info, TokenAccount>>,

    /// Counterparty's YES token account (used when matching against a bid).
    /// Pass user_yes as a placeholder when not used.
    #[account(mut, token::mint = yes_mint)]
    pub counterparty_yes: Box<Account<'info, TokenAccount>>,

    /// Escrow USDC vault (PDA-owned). Holds locked USDC for resting bids.
    #[account(
        mut,
        seeds = [b"usdc_escrow", market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Escrow YES vault (PDA-owned). Holds locked YES for resting asks.
    #[account(
        mut,
        seeds = [b"yes_escrow", market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = market,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event]
pub struct OrderPlaced {
    pub user: Pubkey,
    pub market: Pubkey,
    pub side: u8, // 0 = bid, 1 = ask
    pub price: u16,
    pub size: u64,
    pub index: u8,
}

#[event]
pub struct OrderMatched {
    pub taker: Pubkey,
    pub maker: Pubkey,
    pub market: Pubkey,
    pub taker_side: u8, // 0 = bid, 1 = ask
    pub price: u16,
    pub size: u64,
}

pub fn handler(
    ctx: Context<PlaceOrder>,
    side: OrderSide,
    price: u16,
    size: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(!ctx.accounts.market.settled, MeridianError::AlreadySettled);
    require!(size > 0, MeridianError::SizeMustBeNonZero);
    require!(
        (1..=99).contains(&price),
        MeridianError::PriceOutOfRange
    );

    // Build market PDA signer seeds (used for escrow releases).
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

    let user_key = ctx.accounts.user.key();
    let market_key = ctx.accounts.market.key();
    let clock = Clock::get()?;

    // ---- Phase 1: scan book for best counterparty ----
    let (match_idx, maker_owner, maker_price, maker_size) = {
        let ob = ctx.accounts.orderbook.load()?;
        match side {
            OrderSide::Bid => match ob.best_ask_idx(price) {
                Some(i) => (
                    Some(i),
                    ob.asks[i].owner,
                    ob.asks[i].price,
                    ob.asks[i].size,
                ),
                None => (None, Pubkey::default(), 0, 0),
            },
            OrderSide::Ask => match ob.best_bid_idx(price) {
                Some(i) => (
                    Some(i),
                    ob.bids[i].owner,
                    ob.bids[i].price,
                    ob.bids[i].size,
                ),
                None => (None, Pubkey::default(), 0, 0),
            },
        }
    };

    let mut remaining = size;
    let mut matched_size: u64 = 0;
    let mut matched_price: u16 = 0;
    let mut matched_maker: Pubkey = Pubkey::default();

    // ---- Phase 2: execute the match (CPI) ----
    if let Some(_idx) = match_idx {
        require!(maker_owner != user_key, MeridianError::NotOrderOwner); // no self-trade
        let trade_size = remaining.min(maker_size);
        let usdc_amount_u128 = (trade_size as u128)
            .checked_mul(maker_price as u128)
            .and_then(|v| v.checked_mul(10_000u128))
            .ok_or(MeridianError::MathOverflow)?;
        let usdc_amount: u64 = usdc_amount_u128
            .try_into()
            .map_err(|_| MeridianError::MathOverflow)?;

        match side {
            OrderSide::Bid => {
                // Taker buys YES: counterparty (seller) gets USDC, taker gets YES from escrow.
                require_keys_eq!(
                    ctx.accounts.counterparty_usdc.owner,
                    maker_owner,
                    MeridianError::NotOrderOwner
                );

                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.user_usdc.to_account_info(),
                            to: ctx.accounts.counterparty_usdc.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                        },
                    ),
                    usdc_amount,
                )?;

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
                    trade_size,
                )?;
            }
            OrderSide::Ask => {
                // Taker sells YES: counterparty (buyer) gets YES, taker gets USDC from escrow.
                require_keys_eq!(
                    ctx.accounts.counterparty_yes.owner,
                    maker_owner,
                    MeridianError::NotOrderOwner
                );

                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.user_yes.to_account_info(),
                            to: ctx.accounts.counterparty_yes.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                        },
                    ),
                    trade_size,
                )?;

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
            }
        }

        matched_maker = maker_owner;
        matched_size = trade_size;
        matched_price = maker_price;
        remaining = remaining
            .checked_sub(trade_size)
            .ok_or(MeridianError::MathOverflow)?;

        // Mutate book to decrement matched slot.
        let mut ob = ctx.accounts.orderbook.load_mut()?;
        match side {
            OrderSide::Bid => {
                let idx = match_idx.unwrap();
                ob.asks[idx].size = ob.asks[idx]
                    .size
                    .checked_sub(trade_size)
                    .ok_or(MeridianError::MathOverflow)?;
                if ob.asks[idx].size == 0 {
                    ob.asks[idx] = Order::default();
                }
            }
            OrderSide::Ask => {
                let idx = match_idx.unwrap();
                ob.bids[idx].size = ob.bids[idx]
                    .size
                    .checked_sub(trade_size)
                    .ok_or(MeridianError::MathOverflow)?;
                if ob.bids[idx].size == 0 {
                    ob.bids[idx] = Order::default();
                }
            }
        }
    }

    // ---- Phase 3: rest the remainder on the book ----
    if remaining > 0 {
        match side {
            OrderSide::Bid => {
                let usdc_to_lock_u128 = (remaining as u128)
                    .checked_mul(price as u128)
                    .and_then(|v| v.checked_mul(10_000u128))
                    .ok_or(MeridianError::MathOverflow)?;
                let usdc_to_lock: u64 = usdc_to_lock_u128
                    .try_into()
                    .map_err(|_| MeridianError::MathOverflow)?;

                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.user_usdc.to_account_info(),
                            to: ctx.accounts.usdc_escrow.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                        },
                    ),
                    usdc_to_lock,
                )?;

                let mut ob = ctx.accounts.orderbook.load_mut()?;
                let idx = ob
                    .first_empty_bid()
                    .ok_or(MeridianError::OrderBookFullForSide)?;
                ob.bids[idx].owner = user_key;
                ob.bids[idx].price = price;
                ob.bids[idx].size = remaining;
                ob.bids[idx].timestamp = clock.unix_timestamp;

                emit!(OrderPlaced {
                    user: user_key,
                    market: market_key,
                    side: 0,
                    price,
                    size: remaining,
                    index: idx as u8,
                });
            }
            OrderSide::Ask => {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.user_yes.to_account_info(),
                            to: ctx.accounts.yes_escrow.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                        },
                    ),
                    remaining,
                )?;

                let mut ob = ctx.accounts.orderbook.load_mut()?;
                let idx = ob
                    .first_empty_ask()
                    .ok_or(MeridianError::OrderBookFullForSide)?;
                ob.asks[idx].owner = user_key;
                ob.asks[idx].price = price;
                ob.asks[idx].size = remaining;
                ob.asks[idx].timestamp = clock.unix_timestamp;

                emit!(OrderPlaced {
                    user: user_key,
                    market: market_key,
                    side: 1,
                    price,
                    size: remaining,
                    index: idx as u8,
                });
            }
        }
    }

    if matched_size > 0 {
        emit!(OrderMatched {
            taker: user_key,
            maker: matched_maker,
            market: market_key,
            taker_side: match side {
                OrderSide::Bid => 0,
                OrderSide::Ask => 1,
            },
            price: matched_price,
            size: matched_size,
        });
    }

    Ok(())
}
