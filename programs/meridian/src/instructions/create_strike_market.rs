use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed, program_pack::Pack, system_instruction,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{spl_token, Mint, Token, TokenAccount},
};

use crate::errors::MeridianError;
use crate::state::{Config, Market, OracleAccount, MAX_TICKER_LEN};

/// Create a per-strike binary-options market.
///
/// Initializes:
///   - `Market` PDA          — seeds = ["market", ticker, strike_le, expiry_ts_le]
///   - `yes_mint` (manual)   — seeds = ["yes_mint", market]
///   - `no_mint`  (manual)   — seeds = ["no_mint",  market]
///   - `vault` (ATA)         — owned by the market PDA, holds the USDC collateral
///
/// (The order book and bid/ask escrows are lazily initialized inside
/// `place_order`. This split keeps `create_strike_market` under the 4 KB
/// BPF stack limit.)
///
/// The yes/no mints are created via manual `invoke_signed` rather than
/// Anchor's `init` macro to avoid blowing the stack frame on this instruction.
#[derive(Accounts)]
#[instruction(ticker: String, strike: u64, expiry_ts: i64)]
pub struct CreateStrikeMarket<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = payer,
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

    /// CHECK: PDA seeds verified in handler; account created + initialized
    /// via manual `invoke_signed` to keep the Anchor `init` stack frame small.
    #[account(
        mut,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: UncheckedAccount<'info>,

    /// CHECK: same as `yes_mint`.
    #[account(
        mut,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: UncheckedAccount<'info>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Collateral vault — an ATA owned by the market PDA.
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// Oracle account for the underlying. Must already exist (init via `update_oracle`).
    #[account(
        seeds = [OracleAccount::SEED_PREFIX, ticker.as_bytes()],
        bump = oracle.bump,
    )]
    pub oracle: Box<Account<'info, OracleAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub ticker: String,
    pub strike: u64,
    pub expiry_ts: i64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
}

pub fn handler(
    ctx: Context<CreateStrikeMarket>,
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

    // ---- Create + init yes_mint (manual) ----
    create_pda_mint(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.yes_mint.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        &[b"yes_mint", market_key.as_ref(), &[yes_bump]],
        &market_key,
    )?;

    // ---- Create + init no_mint (manual) ----
    create_pda_mint(
        ctx.accounts.payer.to_account_info(),
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

    emit!(MarketCreated {
        market: market_key,
        ticker,
        strike,
        expiry_ts,
        yes_mint: ctx.accounts.yes_mint.key(),
        no_mint: ctx.accounts.no_mint.key(),
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}

/// Manually create a PDA-owned Mint with 0 decimals and `market_authority`
/// as the mint authority. Uses `invoke_signed` to bypass Anchor's heavy
/// `init` macro for the second-and-third mint accounts.
pub(crate) fn create_pda_mint<'info>(
    payer: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    market: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    market_authority: &Pubkey,
) -> Result<()> {
    let rent = Rent::get()?;
    let mint_len = spl_token::state::Mint::LEN;
    let lamports = rent.minimum_balance(mint_len);

    // Create the mint account.
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            mint.key,
            lamports,
            mint_len as u64,
            token_program.key,
        ),
        &[payer.clone(), mint.clone(), system_program],
        &[signer_seeds],
    )?;

    // Initialize the mint (decimals = 0, authority = market PDA).
    let init_ix = spl_token::instruction::initialize_mint2(
        token_program.key,
        mint.key,
        market_authority,
        None,
        0,
    )?;
    anchor_lang::solana_program::program::invoke(
        &init_ix,
        &[mint, token_program, market],
    )?;

    Ok(())
}
