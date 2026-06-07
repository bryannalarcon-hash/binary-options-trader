// close_settled_book.rs — rent reclamation: close the OrderBook account of a
// SETTLED market and return its lamports to the admin. The book is the largest
// per-market allocation (16+16 zero-copy order slots ≈ 1.8 KB); recycling it
// daily makes market creation SOL-neutral over time. Admin-only; requires the
// book to be completely empty so no maker's escrowed funds lose their on-book
// record (cancel_order works post-settlement — cancel first, then close).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, Market, OrderBook};

#[derive(Accounts)]
pub struct CloseSettledBook<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_bytes(),
            &market.strike.to_le_bytes(),
            &market.expiry_ts.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// The market's order book — closed to `admin` on success.
    #[account(
        mut,
        seeds = [OrderBook::SEED_PREFIX, market.key().as_ref()],
        bump,
        close = admin,
    )]
    pub orderbook: AccountLoader<'info, OrderBook>,

    #[account(mut, address = config.admin @ MeridianError::AdminRequired)]
    pub admin: Signer<'info>,
}

#[event]
pub struct BookClosed {
    pub market: Pubkey,
    pub lamports_reclaimed: u64,
}

pub fn handler(ctx: Context<CloseSettledBook>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.settled, MeridianError::MarketNotSettled);

    // Every slot on both sides must be empty — a resting order's escrow can
    // only be reclaimed via cancel_order, which needs the on-book record.
    {
        let ob = ctx.accounts.orderbook.load()?;
        let all_empty = ob.bids.iter().all(|o| o.is_empty())
            && ob.asks.iter().all(|o| o.is_empty());
        require!(all_empty, MeridianError::OrderBookNotEmpty);
    }

    let reclaimed = ctx.accounts.orderbook.to_account_info().lamports();
    emit!(BookClosed {
        market: market.key(),
        lamports_reclaimed: reclaimed,
    });
    msg!(
        "close_settled_book: market={} reclaimed={} lamports",
        market.key(),
        reclaimed
    );
    // The `close = admin` constraint drains lamports and closes the account
    // after the handler returns Ok.
    Ok(())
}
