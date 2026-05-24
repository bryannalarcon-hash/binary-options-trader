use anchor_lang::prelude::*;

/// Maximum number of resting orders per side (bids / asks) per book.
///
/// Sized for the BPF stack: with zero-copy the account isn't deserialized to
/// the stack, but we still pick 16 per the PRD's CLOB design.
pub const ORDERBOOK_DEPTH: usize = 16;

/// A single resting order on the YES/USDC book.
///
/// `price` is in cents (1..=99 for sane binary-options bounds).
/// `size` is in YES tokens (raw — Yes/No mints have 0 decimals).
///
/// `#[zero_copy]` + `#[repr(C)]` lets us put `[Order; 16]` arrays in an
/// account loader without a stack-blowing deserialization step.
#[zero_copy]
#[repr(C)]
#[derive(Default, Debug)]
pub struct Order {
    /// The wallet that placed the order. `Pubkey::default()` indicates an empty slot.
    pub owner: Pubkey,
    /// Wall-clock timestamp when the order was placed.
    pub timestamp: i64,
    /// Remaining size (YES tokens).
    pub size: u64,
    /// Limit price in cents on a $1.00 scale (must be 1..=99).
    pub price: u16,
    /// Padding so the struct is naturally aligned.
    pub _padding: [u8; 6],
}

impl Order {
    pub fn is_empty(&self) -> bool {
        self.owner == Pubkey::default() && self.size == 0
    }
}

/// In-contract minimal central limit order book (CLOB).
///
/// One book per market. We use fixed-size arrays of `Order` slots with
/// `#[account(zero_copy)]` to avoid stack pressure during deserialization.
///
/// PDA: seeds = ["orderbook", market_pubkey].
#[account(zero_copy)]
#[repr(C)]
pub struct OrderBook {
    /// Market this book belongs to.
    pub market: Pubkey,

    /// PDA bump for this book.
    pub bump: u8,

    /// Padding to align the order arrays.
    pub _padding: [u8; 7],

    /// Resting buy orders (bids). Higher price has priority.
    pub bids: [Order; ORDERBOOK_DEPTH],

    /// Resting sell orders (asks). Lower price has priority.
    pub asks: [Order; ORDERBOOK_DEPTH],
}

impl OrderBook {
    pub const SEED_PREFIX: &'static [u8] = b"orderbook";

    /// Compile-time account size (excluding the 8-byte discriminator).
    /// 32 (market) + 1 (bump) + 7 (pad) + 64 * 16 * 2 = 32+8+2048 = 2088 bytes.
    /// Order = 32+8+8+2+6 = 56 bytes; [Order;16]=896. 32+8+896*2 = 1832.
    pub const SIZE: usize = 32 + 1 + 7 + (core::mem::size_of::<Order>() * ORDERBOOK_DEPTH * 2);

    /// Find the index of the highest-priced bid that crosses (price >= taker_price).
    pub fn best_bid_idx(&self, taker_price: u16) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, o) in self.bids.iter().enumerate() {
            if o.is_empty() || o.size == 0 {
                continue;
            }
            if o.price < taker_price {
                continue;
            }
            match best {
                None => best = Some(i),
                Some(b) => {
                    let cur = &self.bids[b];
                    if o.price > cur.price
                        || (o.price == cur.price && o.timestamp < cur.timestamp)
                    {
                        best = Some(i);
                    }
                }
            }
        }
        best
    }

    /// Find the index of the lowest-priced ask that crosses (price <= taker_price).
    pub fn best_ask_idx(&self, taker_price: u16) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, o) in self.asks.iter().enumerate() {
            if o.is_empty() || o.size == 0 {
                continue;
            }
            if o.price > taker_price {
                continue;
            }
            match best {
                None => best = Some(i),
                Some(b) => {
                    let cur = &self.asks[b];
                    if o.price < cur.price
                        || (o.price == cur.price && o.timestamp < cur.timestamp)
                    {
                        best = Some(i);
                    }
                }
            }
        }
        best
    }

    pub fn first_empty_bid(&self) -> Option<usize> {
        self.bids.iter().position(|o| o.is_empty())
    }

    pub fn first_empty_ask(&self) -> Option<usize> {
        self.asks.iter().position(|o| o.is_empty())
    }
}
