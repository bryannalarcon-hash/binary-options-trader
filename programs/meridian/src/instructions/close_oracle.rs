use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, OracleAccount, MAX_TICKER_LEN};

/// Recovery instruction: close an oracle PDA WITHOUT deserializing it.
///
/// PDA seeds: `["oracle", ticker_bytes]`.
///
/// Why `UncheckedAccount`? A historical `MockOracle → OracleAccount` rename
/// changed the Anchor account discriminator. Existing on-chain oracle PDAs
/// still carry the OLD discriminator, so loading them as
/// `Account<'info, OracleAccount>` would fail with `AccountDiscriminatorMismatch`
/// (exactly the bug that bricked `update_oracle`'s `init_if_needed` path).
///
/// We therefore treat the oracle as an opaque, program-owned account: verify
/// the PDA derivation + program ownership manually, then perform the standard
/// Anchor-0.30 manual close (drain lamports → authority, zero data, reassign to
/// the system program). `update_oracle`'s `init_if_needed` then recreates it
/// fresh with the correct `OracleAccount` discriminator.
///
/// Authority: only `Config.oracle_authority` may sign this instruction
/// (identical gating to `update_oracle`).
#[derive(Accounts)]
#[instruction(ticker: String)]
pub struct CloseOracle<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Oracle authority — must match `Config.oracle_authority`. Receives the
    /// reclaimed rent lamports.
    #[account(mut, address = config.oracle_authority @ MeridianError::InvalidOracleAuthority)]
    pub oracle_authority: Signer<'info>,

    /// CHECK: This is the oracle PDA to close. We deliberately do NOT load it as
    /// `Account<OracleAccount>` because legacy accounts carry a stale
    /// discriminator that would fail deserialization. Instead the handler
    /// manually verifies the PDA derivation (`["oracle", ticker]`) and that the
    /// account is owned by this program before closing it.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
}

#[event]
pub struct OracleClosed {
    pub ticker: String,
    pub oracle: Pubkey,
    pub lamports_reclaimed: u64,
}

pub fn handler(ctx: Context<CloseOracle>, ticker: String) -> Result<()> {
    require!(
        !ticker.is_empty() && ticker.len() <= MAX_TICKER_LEN,
        MeridianError::InvalidTicker
    );

    let oracle_ai = ctx.accounts.oracle.to_account_info();

    // 1. Verify the passed account is the canonical oracle PDA for this ticker.
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[OracleAccount::SEED_PREFIX, ticker.as_bytes()],
        ctx.program_id,
    );
    require_keys_eq!(
        oracle_ai.key(),
        expected_pda,
        MeridianError::InvalidTicker
    );

    // 2. Verify the account is owned by this program (rejects spoofed accounts
    //    and uninitialized / system-owned addresses).
    require_keys_eq!(
        *oracle_ai.owner,
        *ctx.program_id,
        MeridianError::InvalidOracleAuthority
    );

    // 3. Manual close (Anchor 0.30 idiom — mirrors the `close = ` constraint's
    //    `close_account` helper): drain all lamports to the authority and shrink
    //    the data to zero length. Draining to 0 lamports flags the account for
    //    runtime garbage-collection at the end of the transaction, after which
    //    `update_oracle`'s `init_if_needed` can re-create it fresh.
    //
    //    NOTE: we intentionally do NOT call `assign(System)` here. Reassigning
    //    ownership mid-instruction conflicts with the lamport-debit accounting
    //    and silently reverts the close (the account survives with full
    //    lamports). The lamports-to-zero + realloc(0) pattern is what actually
    //    reclaims the rent.
    let dest = ctx.accounts.oracle_authority.to_account_info();
    let lamports_reclaimed = oracle_ai.lamports();

    let dest_starting = dest.lamports();
    **dest.try_borrow_mut_lamports()? = dest_starting
        .checked_add(lamports_reclaimed)
        .ok_or(MeridianError::MathOverflow)?;
    **oracle_ai.try_borrow_mut_lamports()? = 0;

    // Zero then shrink the data so a stale discriminator can never linger.
    oracle_ai.try_borrow_mut_data()?.fill(0);
    oracle_ai.realloc(0, false)?;

    emit!(OracleClosed {
        ticker,
        oracle: oracle_ai.key(),
        lamports_reclaimed,
    });

    Ok(())
}
