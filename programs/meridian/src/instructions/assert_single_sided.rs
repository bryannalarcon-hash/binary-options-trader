use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::errors::MeridianError;
use crate::state::Market;

/// Position-constraint guard: fails if the signer holds BOTH YES and NO for the
/// same strike in their wallet at the moment this instruction runs.
///
/// This is the "close" half of a flash-loan-style pattern. The order-book path
/// (`place_order`) lets a transaction transiently put you into a both-sides
/// state (e.g. Sell-NO buys YES while you still hold NO, then redeems the pair),
/// but requires this assertion to appear LATER in the same transaction. Placed
/// last, it reads the FINAL post-state balances and reverts the whole tx if the
/// transient was never unwound — so a both-sides state can never PERSIST past a
/// transaction boundary on the book path.
///
/// Account order is load-bearing: `place_order`'s introspection matches this
/// instruction by `market` at index 0 and `user` at index 5. Do not reorder.
#[derive(Accounts)]
pub struct AssertSingleSided<'info> {
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
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: only used to bind `user_yes`/`user_no` to this market's mints.
    #[account(address = market.yes_mint)]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: only used to bind `user_yes`/`user_no` to this market's mints.
    #[account(address = market.no_mint)]
    pub no_mint: UncheckedAccount<'info>,

    #[account(token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,
}

pub fn handler(ctx: Context<AssertSingleSided>) -> Result<()> {
    let yes = ctx.accounts.user_yes.amount;
    let no = ctx.accounts.user_no.amount;
    require!(yes == 0 || no == 0, MeridianError::BothSidesHeld);
    Ok(())
}
