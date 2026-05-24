use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{Market, Outcome};

/// Side selector for post-settlement redemption.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenSide {
    Yes,
    No,
}

/// Burn `amount` of the chosen side after settlement.
/// Winning side: receives `amount * 1_000_000` micro-USDC from the vault.
/// Losing side:  burns for $0 (cleanup; preserves token-mint accounting).
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        mut,
        seeds = [
            Market::SEED_PREFIX,
            market.ticker.as_bytes(),
            &market.strike.to_le_bytes(),
            &market.expiry_ts.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = vault,
        has_one = yes_mint,
        has_one = no_mint,
        has_one = usdc_mint,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(address = market.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct Redeemed {
    pub user: Pubkey,
    pub market: Pubkey,
    pub side: u8, // 0 = Yes, 1 = No
    pub amount_burned: u64,
    pub usdc_paid: u64,
}

pub fn handler(ctx: Context<Redeem>, side: TokenSide, amount: u64) -> Result<()> {
    require!(amount > 0, MeridianError::ZeroAmount);
    require!(ctx.accounts.market.settled, MeridianError::NotSettled);
    let outcome = ctx
        .accounts
        .market
        .outcome
        .ok_or(MeridianError::NotSettled)?;

    let (mint_acc, user_token_acc) = match side {
        TokenSide::Yes => (
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.user_yes.to_account_info(),
        ),
        TokenSide::No => (
            ctx.accounts.no_mint.to_account_info(),
            ctx.accounts.user_no.to_account_info(),
        ),
    };

    // Verify user holds enough of the side they're redeeming.
    let held = match side {
        TokenSide::Yes => ctx.accounts.user_yes.amount,
        TokenSide::No => ctx.accounts.user_no.amount,
    };
    require!(held >= amount, MeridianError::NotEnoughBalance);

    // Burn first (regardless of winning / losing — losing side burns for $0).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: mint_acc,
                from: user_token_acc,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    let is_winner = matches!(
        (side, outcome),
        (TokenSide::Yes, Outcome::Yes) | (TokenSide::No, Outcome::No)
    );

    let usdc_paid: u64 = if is_winner {
        let usdc_amount = amount
            .checked_mul(1_000_000)
            .ok_or(MeridianError::MathOverflow)?;
        require!(
            ctx.accounts.vault.amount >= usdc_amount,
            MeridianError::InsufficientFunds
        );

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

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                market_signers,
            ),
            usdc_amount,
        )?;
        usdc_amount
    } else {
        0
    };

    emit!(Redeemed {
        user: ctx.accounts.user.key(),
        market: ctx.accounts.market.key(),
        side: match side {
            TokenSide::Yes => 0,
            TokenSide::No => 1,
        },
        amount_burned: amount,
        usdc_paid,
    });

    Ok(())
}
