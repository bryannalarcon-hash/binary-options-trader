use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{Config, Market, Order, OrderBook};

/// Anchor discriminator of the `assert_single_sided` instruction —
/// `sha256("global:assert_single_sided")[..8]`. Used by the book-path
/// position-constraint guard to locate the trailing assert via introspection.
const ASSERT_SINGLE_SIDED_DISCRIMINATOR: [u8; 8] = [144, 184, 226, 48, 36, 122, 253, 8];

/// Peak taker fee at the 50/50 mid-price, expressed in basis points.
///
/// The full parabolic fee curve is:
///     taker_fee_bps = PEAK_TAKER_FEE_BPS * 4 * p * (100 - p) / 10_000
/// where `p` is the trade price in cents (1..=99).
///
/// At p = 50:        fee = 150 * 4 * 50 * 50 / 10_000 = 150 bps (1.5%) PEAK
/// At p = 99 or 1:   fee = 150 * 4 * 99 *  1 / 10_000 =   5 bps (integer-truncated)
/// At p = 65:        fee = 150 * 4 * 65 * 35 / 10_000 = 136 bps
/// At p = 0 / 100:   fee = 0 (but those prices are already rejected by the
///                            `(1..=99).contains(&price)` guard above).
///
/// Spec reference: IMPLEMENTATION_PLAN.md §3 fee model.
pub const PEAK_TAKER_FEE_BPS: u128 = 150;

/// Basis-point divisor (1 bp = 0.01% = 1/10_000).
pub const BPS_DIVISOR: u128 = 10_000;

/// Compute the parabolic taker fee for a single fill.
///
/// Returns the fee amount in micro-USDC. Saturates to zero for malformed
/// prices outside the 1..=99 range (defensive — the caller already enforces).
///
/// Notional itself is `size * price * 10_000` micro-USDC (price is cents,
/// USDC is 6 decimals, YES tokens are integer units).
fn compute_taker_fee(notional_usdc: u64, price_cents: u16) -> Result<u64> {
    if price_cents == 0 || price_cents >= 100 {
        return Ok(0);
    }
    // taker_fee_bps = PEAK * 4 * p * (100 - p) / 10_000   (units: bps)
    let p = price_cents as u128;
    let raw_bps = PEAK_TAKER_FEE_BPS
        .checked_mul(4)
        .and_then(|v| v.checked_mul(p))
        .and_then(|v| v.checked_mul(100u128.saturating_sub(p)))
        .ok_or(MeridianError::MathOverflow)?
        / BPS_DIVISOR;
    // fee = notional * raw_bps / 10_000
    let fee_u128 = (notional_usdc as u128)
        .checked_mul(raw_bps)
        .ok_or(MeridianError::MathOverflow)?
        / BPS_DIVISOR;
    let fee: u64 = fee_u128.try_into().map_err(|_| MeridianError::MathOverflow)?;
    Ok(fee)
}

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
        has_one = no_mint,
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

    #[account(address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(address = market.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Taker's USDC token account.
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// Taker's YES token account.
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// Taker's NO token account (read-only). Used by the book-path position
    /// guard: a Bid that acquires YES while this balance is > 0 must be unwound
    /// by a trailing `assert_single_sided` in the same transaction.
    #[account(token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

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

    /// Protocol fee destination's USDC token account.
    ///
    /// Must be owned by `config.fee_destination` and hold `config.usdc_mint`.
    /// The bootstrap script is responsible for creating this ATA before the
    /// first trade lands on each new deployment. If the ATA is missing the
    /// instruction will fail loudly — we DO NOT silently bypass the fee.
    ///
    /// TODO(maker-rebate): once we support atomic maker rebates, accept an
    /// additional `maker_usdc` account here and credit a small fraction of
    /// the parabolic fee back to the resting side. Skipped in v1 for
    /// simplicity (see IMPLEMENTATION_PLAN §3).
    #[account(
        mut,
        token::mint = usdc_mint,
        constraint = fee_destination_usdc.owner == config.fee_destination
            @ MeridianError::InvalidFeeDestination,
    )]
    pub fee_destination_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// Instructions sysvar — read by the book-path position guard to verify a
    /// trailing `assert_single_sided` exists when a Bid acquires YES while the
    /// buyer holds NO.
    /// CHECK: validated by its well-known sysvar address.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
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

#[event]
pub struct FeeCharged {
    pub taker: Pubkey,
    pub market: Pubkey,
    pub price: u16,
    pub size: u64,
    /// Notional in micro-USDC (size * price * 10_000).
    pub notional: u64,
    /// Fee in micro-USDC actually transferred to `fee_destination_usdc`.
    pub fee: u64,
}

/// Scan the Instructions sysvar for an `assert_single_sided` instruction that
/// runs AFTER the current one, targeting this program + market + user. The
/// guard's account order is `[market(0), yes_mint(1), no_mint(2), user_yes(3),
/// user_no(4), user(5)]`, so we match `market` at index 0 and `user` at index 5.
/// Returns Ok if found, else `SingleSidedGuardMissing`.
fn require_trailing_single_sided_assert(
    instructions_sysvar: &AccountInfo,
    program_id: &Pubkey,
    market: &Pubkey,
    user: &Pubkey,
) -> Result<()> {
    let current = ix_sysvar::load_current_index_checked(instructions_sysvar)? as usize;
    let mut i = current + 1;
    while let Ok(ix) = ix_sysvar::load_instruction_at_checked(i, instructions_sysvar) {
        if ix.program_id == *program_id
            && ix.data.len() >= 8
            && ix.data[..8] == ASSERT_SINGLE_SIDED_DISCRIMINATOR
            && ix.accounts.len() >= 6
            && ix.accounts[0].pubkey == *market
            && ix.accounts[5].pubkey == *user
        {
            return Ok(());
        }
        i += 1;
    }
    err!(MeridianError::SingleSidedGuardMissing)
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

        // Parabolic taker fee on this fill — peaks at 50/50, ~0 at 1¢/99¢.
        // The maker always sees full notional; the fee is shouldered entirely
        // by the taker (whether they're the buyer or the seller). See
        // IMPLEMENTATION_PLAN §3 fee model.
        let taker_fee = compute_taker_fee(usdc_amount, maker_price)?;

        match side {
            OrderSide::Bid => {
                // Taker buys YES: counterparty (seller) gets full USDC notional,
                // taker gets YES from escrow, taker ALSO pays `taker_fee` on top
                // to fee_destination_usdc.
                require_keys_eq!(
                    ctx.accounts.counterparty_usdc.owner,
                    maker_owner,
                    MeridianError::NotOrderOwner
                );

                // 1. Notional: taker_usdc -> maker_usdc
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

                // 2. Fee: taker_usdc -> fee_destination_usdc (only if > 0)
                if taker_fee > 0 {
                    token::transfer(
                        CpiContext::new(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.user_usdc.to_account_info(),
                                to: ctx.accounts.fee_destination_usdc.to_account_info(),
                                authority: ctx.accounts.user.to_account_info(),
                            },
                        ),
                        taker_fee,
                    )?;
                }

                // 3. YES: escrow -> taker_yes
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
                // Taker sells YES: counterparty (buyer) gets YES, taker gets
                // USDC from escrow MINUS the fee, fee_destination_usdc gets
                // the fee from the same escrow. Net: maker paid full notional
                // (their lock was already exactly `usdc_amount`), taker nets
                // `usdc_amount - fee`, protocol nets `fee`.
                require_keys_eq!(
                    ctx.accounts.counterparty_yes.owner,
                    maker_owner,
                    MeridianError::NotOrderOwner
                );

                // 1. YES: taker_yes -> maker_yes
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

                // 2. USDC (net): escrow -> taker_usdc
                let net_to_taker = usdc_amount
                    .checked_sub(taker_fee)
                    .ok_or(MeridianError::MathOverflow)?;
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
                    net_to_taker,
                )?;

                // 3. USDC (fee): escrow -> fee_destination_usdc
                if taker_fee > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.usdc_escrow.to_account_info(),
                                to: ctx.accounts.fee_destination_usdc.to_account_info(),
                                authority: ctx.accounts.market.to_account_info(),
                            },
                            market_signers,
                        ),
                        taker_fee,
                    )?;
                }
            }
        }

        if taker_fee > 0 {
            emit!(FeeCharged {
                taker: user_key,
                market: market_key,
                price: maker_price,
                size: trade_size,
                notional: usdc_amount,
                fee: taker_fee,
            });
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

    // ---- Book-path position guard ----
    // If this Bid actually acquired YES (a fill) while the buyer holds NO, the
    // buyer is now transiently both-sided. That is only allowed if the same
    // transaction unwinds it — enforced by requiring a trailing
    // `assert_single_sided` (which, running last, reverts the tx if the buyer
    // still holds both). Resting bids (matched_size == 0) acquire no YES, so
    // they're exempt (this is what lets the MM quote while holding NO inventory).
    if matches!(side, OrderSide::Bid) && matched_size > 0 && ctx.accounts.user_no.amount > 0 {
        require_trailing_single_sided_assert(
            &ctx.accounts.instructions.to_account_info(),
            ctx.program_id,
            &market_key,
            &user_key,
        )?;
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
