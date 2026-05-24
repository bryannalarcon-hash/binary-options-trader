use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{Config, Market};

/// Burn `amount_pairs` of YES + NO and receive `amount_pairs * 1_000_000`
/// micro-USDC back from the vault. Callable pre- or post-settlement;
/// preserves the vault invariant.
#[derive(Accounts)]
pub struct RedeemPair<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Account<'info, Config>,

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
pub struct PairRedeemed {
    pub user: Pubkey,
    pub market: Pubkey,
    pub amount_pairs: u64,
    pub total_pairs_minted: u64,
}

pub fn handler(ctx: Context<RedeemPair>, amount_pairs: u64) -> Result<()> {
    require!(amount_pairs > 0, MeridianError::ZeroAmount);
    require!(
        ctx.accounts.user_yes.amount >= amount_pairs,
        MeridianError::NotEnoughBalance
    );
    require!(
        ctx.accounts.user_no.amount >= amount_pairs,
        MeridianError::NotEnoughBalance
    );

    let usdc_amount = amount_pairs
        .checked_mul(1_000_000)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        ctx.accounts.vault.amount >= usdc_amount,
        MeridianError::InsufficientFunds
    );

    // Burn YES
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_pairs,
    )?;

    // Burn NO
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_pairs,
    )?;

    // Transfer USDC vault → user (signed by market PDA)
    let ticker_bytes = ctx.accounts.market.ticker.as_bytes().to_vec();
    let strike_bytes = ctx.accounts.market.strike.to_le_bytes();
    let expiry_bytes = ctx.accounts.market.expiry_ts.to_le_bytes();
    let bump = [ctx.accounts.market.bump];
    let signer_seeds: &[&[u8]] = &[
        Market::SEED_PREFIX,
        &ticker_bytes,
        &strike_bytes,
        &expiry_bytes,
        &bump,
    ];
    let signers = &[signer_seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signers,
        ),
        usdc_amount,
    )?;

    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market
        .total_pairs_minted
        .checked_sub(amount_pairs)
        .ok_or(MeridianError::MathOverflow)?;

    emit!(PairRedeemed {
        user: ctx.accounts.user.key(),
        market: market.key(),
        amount_pairs,
        total_pairs_minted: market.total_pairs_minted,
    });

    Ok(())
}
