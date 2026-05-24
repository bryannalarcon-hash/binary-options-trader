use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{Config, Market};

/// Mint a pair: user transfers `amount_pairs * 1_000_000` micro-USDC to the
/// vault and receives `amount_pairs` YES + `amount_pairs` NO tokens.
///
/// Invariants enforced:
///   - Program not paused
///   - Market not settled
///   - amount_pairs > 0
///   - vault USDC balance == total_pairs_minted * 1_000_000 (post-condition implied)
#[derive(Accounts)]
pub struct MintPair<'info> {
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

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct PairMinted {
    pub user: Pubkey,
    pub market: Pubkey,
    pub amount_pairs: u64,
    pub total_pairs_minted: u64,
}

pub fn handler(ctx: Context<MintPair>, amount_pairs: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(!ctx.accounts.market.settled, MeridianError::AlreadySettled);
    require!(amount_pairs > 0, MeridianError::ZeroAmount);

    let usdc_amount = amount_pairs
        .checked_mul(1_000_000)
        .ok_or(MeridianError::MathOverflow)?;

    // 1) Pull USDC from user → vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // 2) Build the market PDA signer seeds
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

    // 3) Mint YES to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signers,
        ),
        amount_pairs,
    )?;

    // 4) Mint NO to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signers,
        ),
        amount_pairs,
    )?;

    // 5) Update accounting + emit
    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market
        .total_pairs_minted
        .checked_add(amount_pairs)
        .ok_or(MeridianError::MathOverflow)?;

    emit!(PairMinted {
        user: ctx.accounts.user.key(),
        market: market.key(),
        amount_pairs,
        total_pairs_minted: market.total_pairs_minted,
    });

    Ok(())
}
