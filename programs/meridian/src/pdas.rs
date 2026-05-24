use anchor_lang::prelude::Pubkey;

/// Centralized PDA seed builders. Mirror these constants in any TS client.
pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const YES_MINT_SEED: &[u8] = b"yes_mint";
pub const NO_MINT_SEED: &[u8] = b"no_mint";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ORACLE_SEED: &[u8] = b"oracle";
pub const ORDERBOOK_SEED: &[u8] = b"orderbook";
pub const USDC_ESCROW_SEED: &[u8] = b"usdc_escrow";
pub const YES_ESCROW_SEED: &[u8] = b"yes_escrow";

/// Derive the global config PDA.
pub fn config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}

/// Derive a market PDA for (ticker, strike, expiry_ts).
/// `ticker` is the ASCII ticker bytes (e.g. b"AAPL"), `strike` is cents.
pub fn market_pda(
    program_id: &Pubkey,
    ticker: &[u8],
    strike: u64,
    expiry_ts: i64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            MARKET_SEED,
            ticker,
            &strike.to_le_bytes(),
            &expiry_ts.to_le_bytes(),
        ],
        program_id,
    )
}

/// Derive the YES mint PDA for a given market.
pub fn yes_mint_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[YES_MINT_SEED, market.as_ref()], program_id)
}

/// Derive the NO mint PDA for a given market.
pub fn no_mint_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[NO_MINT_SEED, market.as_ref()], program_id)
}

/// Derive the USDC vault PDA (the authority/ATA owner) for a given market.
pub fn vault_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, market.as_ref()], program_id)
}

/// Derive the mock oracle PDA for a given ticker.
pub fn oracle_pda(program_id: &Pubkey, ticker: &[u8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ORACLE_SEED, ticker], program_id)
}

/// Derive the orderbook PDA for a given market.
pub fn orderbook_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ORDERBOOK_SEED, market.as_ref()], program_id)
}
