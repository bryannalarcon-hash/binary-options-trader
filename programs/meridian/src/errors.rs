use anchor_lang::prelude::*;

/// Custom error codes for the Meridian program.
///
/// Numbering starts at 6000 (Anchor convention for user error codes).
/// All variants here are emitted from `instructions/*.rs` modules.
#[error_code]
pub enum MeridianError {
    #[msg("Program is paused by admin")]
    Paused,

    #[msg("Market is already settled")]
    AlreadySettled,

    #[msg("Market is not yet settled")]
    NotSettled,

    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Arithmetic overflow or underflow")]
    MathOverflow,

    #[msg("Strike price is invalid")]
    InvalidStrike,

    #[msg("Oracle price is too stale to use")]
    OraclesStale,

    #[msg("Oracle confidence band is too wide")]
    OracleConfidenceWide,

    #[msg("This instruction requires the admin signer")]
    AdminRequired,

    #[msg("Time gate has not elapsed (e.g. settle before expiry, or override before 1h delay)")]
    TimeGateNotElapsed,

    #[msg("Order book is full for this side")]
    OrderBookFullForSide,

    #[msg("Order not found at given index")]
    OrderNotFound,

    #[msg("Order index out of range")]
    InvalidOrderIndex,

    #[msg("Insufficient funds in account or vault")]
    InsufficientFunds,

    #[msg("Insufficient balance for requested operation")]
    NotEnoughBalance,

    #[msg("Invalid price (must be 1..=99 cents on a $1.00 binary)")]
    InvalidPrice,

    #[msg("Price out of range (must be 1..=99 cents)")]
    PriceOutOfRange,

    #[msg("Size must be non-zero")]
    SizeMustBeNonZero,

    #[msg("Caller is not the order owner")]
    NotOrderOwner,

    #[msg("Ticker string is invalid or too long")]
    InvalidTicker,

    #[msg("Oracle authority mismatch")]
    InvalidOracleAuthority,

    #[msg("Settlement outcome mismatch — token side cannot redeem against current outcome")]
    InvalidRedeemSide,

    #[msg("Settlement outcome was not the winning side")]
    NotWinningSide,

    #[msg("Oracle price is negative")]
    OracleNegativePrice,

    #[msg("Oracle exponent invalid for cents conversion")]
    OracleInvalidExpo,

    #[msg("Order book is full")]
    OrderBookFull,

    #[msg("Fee destination USDC ATA does not match config.fee_destination")]
    InvalidFeeDestination,

    #[msg("Invalid risk parameter (staleness must be > 0; confidence bps in 1..=10000)")]
    InvalidRiskParam,

    #[msg("Cannot hold both YES and NO on the same strike at once")]
    BothSidesHeld,

    #[msg("Buying YES while holding NO requires a trailing assert_single_sided in the same transaction")]
    SingleSidedGuardMissing,

    #[msg("Config account is not in a migratable layout (wrong owner or too small)")]
    InvalidConfigLayout,

    #[msg("Market must be settled before its book can be closed")]
    MarketNotSettled,

    #[msg("Order book still has resting orders — cancel them before closing")]
    OrderBookNotEmpty,
}
