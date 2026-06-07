// Anchor's #[program] macro needs the per-instruction `__client_accounts_*`
// and `__cpi_client_accounts_*` helper modules in scope; the cleanest way is
// to glob-export every instruction module. This also re-exports each module's
// `handler` fn, but those are referenced only via fully-qualified
// `instructions::<name>::handler` in lib.rs, so the warning is benign.
#![allow(ambiguous_glob_reexports)]

pub mod initialize_config;
pub mod create_strike_market;
pub mod init_market_books;
pub mod add_strike;
pub mod assert_single_sided;
pub mod migrate_config;
pub mod mint_pair;
pub mod redeem_pair;
pub mod place_order;
pub mod cancel_order;
pub mod settle_market;
pub mod admin_settle_override;
pub mod redeem;
pub mod pause;
pub mod set_risk_params;
pub mod update_oracle;
pub mod close_oracle;
pub mod close_settled_book;

pub use initialize_config::*;
pub use create_strike_market::*;
pub use init_market_books::*;
pub use add_strike::*;
pub use assert_single_sided::*;
pub use migrate_config::*;
pub use mint_pair::*;
pub use redeem_pair::*;
pub use place_order::*;
pub use cancel_order::*;
pub use settle_market::*;
pub use admin_settle_override::*;
pub use redeem::*;
pub use pause::*;
pub use set_risk_params::*;
pub use update_oracle::*;
pub use close_oracle::*;
pub use close_settled_book::*;
