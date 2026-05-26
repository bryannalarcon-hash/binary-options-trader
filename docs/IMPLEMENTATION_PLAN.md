# Meridian — Implementation Plan

**Project:** Gauntlet Project — Meridian
**Subtitle:** Binary Stock Outcome Markets on Blockchain
**Source spec:** the Meridian project assignment brief (provided separately; not committed to this repo)
**Status:** Draft v1 — incorporates research synthesis from competitive analysis (Polymarket, Kalshi, Augur, Manifold, Solana-native protocols)

---

## 0. How to read this document

Every item in this plan is tagged:

- **[MUST]** — PRD requirement. Non-negotiable. Failure to deliver = failed submission.
- **[SHOULD]** — Strong recommendation from competitive research. Materially improves the product but not in the PRD.
- **[MAY]** — Optional enhancement worth considering if time permits.

When PRD wording is ambiguous, the strictest reading wins. When research recommendations conflict with the PRD, the PRD takes priority and the recommendation is dropped or restructured.

---

## 1. Product surface — what Meridian is

A non-custodial decentralized application that trades binary outcome contracts tied to the daily closing prices of MAG7 US equities (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA). Each contract asks *"Will [STOCK] close at or above [PRICE] today?"* and pays $1 USDC if Yes, $0 if No. Contracts expire same-day (0DTE) and settle at 4:00 PM ET via on-chain price oracle. Users trade complementary Yes and No tokens on an on-chain order book. **No KYC, no custody, no margin.**

---

## 2. Hard constraints from the PRD [MUST]

### 2.1 Underlying assets
The 7 stocks in V1 (the "MAG7"): AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.

### 2.2 Contract mechanics
- Binary Yes/No tokens per (stock, strike, date).
- Yes payout + No payout = $1.00 USDC **always** (the invariant).
- Yes pays $1 if `closing_price >= strike_price`, else $0 (at-or-above rule).
- No is the inverse.
- 0DTE expiry; settlement at 4:00 PM ET via on-chain oracle.

### 2.3 Strike algorithm
- Read previous day's closing price from oracle each morning.
- Generate strikes at ±3%, ±6%, ±9% from previous close, rounded to nearest $10.
- Produces 6 strikes per stock (3 above, 3 below), plus optionally a 7th strike at the rounded previous close.
- Deduplicate identical rounded values (low-priced stocks like AAPL @ $230 will collide; deduplicate to unique strikes only).
- Admin can add or adjust strikes during the trading day.

### 2.4 Daily lifecycle (all timestamps ET)
| Time | Event |
|---|---|
| 8:00 AM | Automation reads previous close, calculates strikes |
| 8:30 AM | Automation creates contracts and order books for each strike |
| 9:00 AM | Markets visible on frontend, minting enabled |
| 9:30 AM | US market open, live trading begins |
| 4:00 PM | US market close |
| ~4:05 PM | Automation reads oracle closing price, calls settle on all contracts |
| 4:05 PM+ | Redemption enabled |
| Ongoing | Unredeemed tokens remain redeemable indefinitely |

### 2.5 Required smart contract functions
| Function | Description |
|---|---|
| `initialize_config` | One-time global setup: admin authority, supported tickers, oracle feed references |
| `create_strike_market` | Create one contract for (stock, strike, day). Creates Yes mint, No mint, vault, order book market. Called once per strike, not batched. |
| `add_strike` | Admin function to add extra strikes intraday |
| `mint_pair` | User deposits $1 USDC, receives 1 Yes + 1 No |
| `settle_market` | Reads oracle close, writes binary outcome. Callable only after 4:00 PM ET. MUST validate oracle freshness and confidence. |
| `admin_settle_override` | Admin-only fallback for oracle failure. **MUST enforce mandatory time delay (e.g., 1 hour after market close) before invokable.** |
| `redeem` | Token holder burns winning tokens, receives $1 each. Losing tokens redeem for $0. |
| `pause` / `unpause` | Admin can halt minting and trading in an emergency |

### 2.6 On-chain invariants (must be enforced by the program)
- Vault USDC balance = $1.00 × total pairs minted (exact; any fees go to a separate account).
- Yes payout + No payout = $1.00 at settlement, always.
- Tokens can only be created via `mint_pair`.
- Tokens can only be destroyed via `redeem`.
- Settlement outcome is immutable once written.

### 2.7 Oracle requirements
- `settle_market` MUST read the stock's closing price on-chain from the oracle during the settlement transaction.
- **Staleness check:** reject prices older than a defined threshold (e.g., 5 minutes).
- **Confidence check:** reject prices where the oracle's reported confidence band is too wide (configurable threshold).
- Pre-market price read (for strike calculation each morning) MAY use an off-chain API call to the oracle.
- **Failure handling:** automation retries for a defined window (e.g., 15 minutes). If still failing, admin uses `admin_settle_override` with manual price and enforced time delay.

### 2.8 Position constraints (UI-enforced) [MUST]
- A user MUST NOT be able to Buy Yes if they already hold No tokens for the same strike without first selling (closing) their No position.
- A user MUST NOT be able to Buy No if they already hold Yes tokens for the same strike without first selling their Yes.
- The contract permits transient pair-holding during the mint-pair operation; the UI enforces that this is not a persistent user-facing state.
- Frontend MUST check the user's token balances before presenting trade options and guide them to exit their current position first.

> **Note:** Competitive research showed that Polymarket allows holding both sides (with a CTF `mergePositions` recovery) and Kalshi silently auto-nets. The Meridian PRD takes a stricter stance — we honor it. To minimize friction, the UI offers a one-tap "close position then enter opposite side" flow that runs both actions as two back-to-back transactions (NOT atomic — the CLOB sweep can't reliably fit both legs in one tx; see UX section).

### 2.9 Required pages
- **Landing** — product explanation, live prices, connect wallet CTA.
- **Markets** — grid of 7 stocks with live prices and active contract counts.
- **Trade** — strike list for selected stock, order book (both Yes and No perspectives of the same book), Buy Yes / Buy No / Sell Yes / Sell No panel.
- **Portfolio** — active positions, settled outcomes, P&L, redeem buttons.
- **History** — trade execution log.

### 2.10 Required UI elements
- Contract cards showing strike, current Yes/No prices, implied probability.
- Real-time order book from the CLOB, displayed for both Yes and No perspectives (same book, two views).
- Trade panel with Buy Yes / Buy No / Sell Yes / Sell No.
- Position-aware constraints (the rule from 2.8 visible in UI affordances).
- Settlement countdown timer to 4:00 PM ET.
- Simple payoff display: *"You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]."*
- Portfolio with entry price, current price, P&L, and redeem button for settled contracts.

### 2.11 Tech stack
- **Smart contract:** Rust + Anchor framework on Solana. (Spec marks this as "preferred"; we treat as our chosen path. Solidity on an EVM L2 is acceptable per the spec but would introduce CLOB latency concerns.)
- **Frontend:** TypeScript + React, Next.js.
- **Automation service:** TypeScript / Node.js.

### 2.12 Deployment requirements
- **Solana devnet deployment is REQUIRED to pass.** Reproducible scripts to deploy contracts, create markets, run full lifecycle.
- Demonstrate `create → mint → trade → settle → redeem` end-to-end on testnet.
- Tests run locally and validate all key invariants.
- Clear README with one-command setup (e.g., `make dev` or equivalent).
- Secrets via environment variables; provide `.env.example`.
- **Never use mainnet or real funds for the core submission.**
- Use standard dev tools for the chosen chain; be prepared to justify choices.
- Avoid unnecessary third-party abstractions; justify all major dependencies.

### 2.13 Testing requirements
- **Smart contract:** unit tests for all core functions; settlement logic (at-strike, above-strike, below-strike); invariant tests (Yes + No = $1 for all prices, vault balance after every mint/redeem); oracle validation (stale price, wide confidence, valid scenarios); admin override with time-delay enforcement.
- **Integration:** full lifecycle (create → mint → trade on order book → settle → redeem); all 4 trade paths (Buy Yes, Buy No, Sell Yes, Sell No); multi-user scenario (one mints and quotes, another takes, both redeem).
- **Frontend:** wallet connection flow, order placement and tx signing, real-time price display from oracle, order book rendering (both Yes and No views of the same book), position constraint enforcement, portfolio and P&L accuracy, settlement display and redeem flow.

### 2.14 Documentation
- Short risks/limitations note (no regulatory or compliance claims).
- Architecture decisions and trade-offs explained.
- Alternatives considered and rationale for choices.

### 2.15 Bonus (not required)
- Solana mainnet-beta deployment with funded automation wallet, production oracle feeds, monitoring/alerting.

---

## 3. Architecture decisions (with justifications)

| Decision | Choice | Justification |
|---|---|---|
| Chain | **Solana devnet** (mainnet-beta as bonus) | PRD-preferred; sub-second finality is required for live order book trading; Pyth oracle has institutional MAG7 equity feeds; existing CLOB infrastructure (Phoenix) is mature; transaction fees ~$0.0003 keep micro-trades viable. |
| Smart contract language | **Rust + Anchor** | PRD-preferred; Anchor gives IDL generation, account-validation macros, typed TS client; matches every reference implementation (Drift, OpenBook, Zeta, Hxro). |
| On-chain order book | **Phoenix V1** (one market per strike) | Crankless atomic fills — no orphaned orders at 4 PM ET when markets close. MIT-licensed, OtterSec-audited, $75B+ cumulative volume. Permissionless market creation. Alternative considered: OpenBook V2 (requires crank); custom CLOB (6-month detour for no functional advantage). |

> **Build note (as shipped):** Phoenix is **not** deployed on localnet/devnet, so the shipped build uses a **minimal in-program CLOB** instead of Phoenix CPI. Bid/ask arrays (size 16) live in an `OrderBook` PDA (`state/orderbook.rs`); orders match on-place inside the same Solana transaction (`instructions/place_order.rs`). Sub-second match is still achieved via Solana block time (~400ms). No Phoenix instruction is ever invoked.
| Token model | **Two SPL mints per (stock, strike, date)**, mint authority held by market PDA | Standard Solana pattern; lets us use the SPL Token program for transfers/burns/mints. Each (stock, strike, date) is uniquely identified by its mint addresses. ~70–100 new mints/day at scale; rent-exempt deposits are cheap. |
| Oracle | **Pyth Pull (PriceUpdateV2)** primary, **Switchboard** as documented fallback | Pyth already powers Polymarket's daily-close equity markets (April 2026, BusinessWire). Confirmed feeds for AAPL, NVDA, TSLA; MSFT/GOOGL/AMZN/META need verification before launch but are highly likely covered. Pyth feeds run ~24/5 (verified, contradicting earlier assumption). Use `get_price_no_older_than(clock, 30s, feed_id)` at settlement with confidence threshold. |

> **Build note (as shipped):** The shipped build does **not** consume Pyth's on-chain `PriceUpdateV2` / Pull Receiver. Instead the automation service polls the **Pyth Hermes HTTP API** (`hermes.pyth.network`) every 30 s and writes prices into a custom `OracleAccount` PDA via `update_oracle`. `settle_market` reads that account with the same staleness + confidence checks. Prices still originate from Pyth; only the on-chain delivery mechanism differs. See `automation/src/jobs/update-mock-oracle.ts` and [README.md](../README.md) §architecture.
| Settlement model | **Autonomous oracle settlement** (NOT multisig) | Drift's prediction-market multisig was compromised April 2026 for ~$285M — direct evidence that human-controlled settlement is fragile. Pyth confidence/staleness checks gate the autonomous settle; admin override exists only as fallback with 1-hour enforced delay per PRD. |
| Account model | Market PDA + 2 mint PDAs + USDC vault ATA; per-user positions = SPL token balances | Mirrors every Solana DeFi reference. No per-user state on Meridian's side. PDAs derived deterministically from `(b"market", underlying, strike, expiry)`. |
| Fee model | Taker peak 1.5% × `P × (1−P) × 4` (zero at extremes, 1.5% at 50/50); maker rebate 0.4% × same curve | Parabolic `P × (1−P)` curve is standard at Kalshi (0.07 × scale) and Polymarket Finance category (~1% peak). Splits the middle. Rebate incentivizes market makers — critical for liquidity bootstrapping at launch. Fee collection routed to a separate fee account (per PRD invariant 2.6). |

---

## 4. Smart contract design

### 4.1 Account layout

```
ConfigAccount               (1, global)
├─ admin: Pubkey
├─ supported_tickers: [String; 7]
├─ pyth_feeds: HashMap<Ticker, Pubkey>
├─ paused: bool
└─ fee_destination: Pubkey

MarketAccount               (one per stock/strike/day)  PDA: ["market", ticker, strike, expiry]
├─ ticker: String
├─ strike: u64                 (in cents, e.g., 22000 = $220.00)
├─ expiry_ts: i64              (4 PM ET Unix timestamp)
├─ yes_mint: Pubkey            PDA: ["yes_mint", market]
├─ no_mint: Pubkey             PDA: ["no_mint", market]
├─ vault: Pubkey               (USDC token account owned by market PDA)
├─ phoenix_market: Pubkey      (the Phoenix CLOB instance for Yes/USDC)
├─ settled: bool
├─ settlement_outcome: Option<Outcome>   (Yes wins | No wins)
├─ settlement_ts: Option<i64>
└─ total_pairs_minted: u64     (for vault invariant check)
```

### 4.2 Instruction map (matches PRD §2.5)

```rust
// [MUST] — PRD-required functions
pub fn initialize_config(ctx, admin: Pubkey, tickers: Vec<String>, fee_destination: Pubkey)
pub fn create_strike_market(ctx, ticker: String, strike: u64, expiry_ts: i64)
pub fn add_strike(ctx, ticker: String, strike: u64) -> requires admin signer
pub fn mint_pair(ctx, amount_pairs: u64) -> transfers amount_pairs USDC in, mints amount_pairs Yes + amount_pairs No
pub fn settle_market(ctx) -> reads Pyth feed, validates staleness + confidence, writes outcome (uses >= for at-or-above rule)
pub fn admin_settle_override(ctx, manual_price: u64) -> requires admin + time delay (>= 1h post-expiry)
pub fn redeem(ctx, side: TokenSide, amount: u64) -> burns tokens, transfers USDC payout (post-settlement only)
pub fn pause(ctx) / unpause(ctx) -> requires admin

// [SHOULD] — needed to support PRD Sell-No auto-close flow (PRD §2.10 lists this as alternative)
pub fn redeem_pair(ctx, amount_pairs: u64) -> burns amount_pairs Yes + amount_pairs No, returns amount_pairs USDC; callable anytime (pre or post settlement)
```

### 4.3 Invariant enforcement
- `mint_pair` and `redeem` both update `total_pairs_minted` and assert vault USDC equality.
- `redeem_pair` decrements `total_pairs_minted` and transfers $1 × pairs out of vault; preserves vault invariant.
- **Settlement comparison uses `>=` (at-or-above rule per PRD §2.2):** `closing_price >= strike → Yes wins; else No wins`. Off-by-one rounding must be tested at the strike boundary.
- `settle_market` is a one-shot — checks `settled == false`, sets `settled = true`, writes `settlement_outcome`. Subsequent calls revert.
- `admin_settle_override` checks `clock.unix_timestamp >= expiry_ts + 3600` (1-hour delay).
- Pause flag checked in `mint_pair`, `redeem_pair`, and any future trade-touching instructions.

### 4.4 Tests (matches PRD §2.13)
- Unit: every instruction, success + failure paths.
- Property/fuzz: `for all p in [0, max_price]: yes_payout(p) + no_payout(p) == 1` (per PRD).
- Invariant: vault balance equals `1 USDC × total_pairs_minted` after every mint + redeem.
- Oracle: stale price rejection, wide-confidence rejection, valid path.
- Admin override: rejects before time delay, succeeds after.
- Full lifecycle integration test on local validator.

---

## 5. Frontend design (Next.js + TypeScript + React)

### 5.1 Required pages (PRD §2.9)
- `/` Landing — product explanation, live MAG7 prices, connect-wallet CTA
- `/markets` Markets grid — **7 stocks grouped by ticker**, each card shows live price + active contract count; clicking expands to strike list
- `/trade/[ticker]/[strike]` Trade page (strike list, order book both perspectives, trade panel)
- `/portfolio` Portfolio
- `/history` Trade history

### 5.2 Required UI elements (PRD §2.10) + research-driven enhancements

| Element | PRD requirement | Research enhancement [SHOULD] |
|---|---|---|
| Price display | Yes/No prices + implied probability | Display price as both cents AND probability ("65¢ = 65%") — verified universal across Polymarket / Kalshi / Manifold |
| **Implied No price** | $1.00 − Yes price computed and shown next to Yes price on every card | Update in real-time as Yes price moves |
| **USDC balance display** | Shown immediately on wallet connect; refreshed on every state-changing action | Persistent header chip visible across all pages |
| **Active contracts grouped by stock ticker** | Markets page must group browsing by ticker (per PRD §2.10 user-story walkthrough) | Sticky ticker headers; collapse/expand per group |
| Order book | Both Yes and No perspectives of same book | Compact depth bars; "spread" callout; recent trades inline |
| Trade panel | Buy Yes / Buy No / Sell Yes / Sell No buttons | Bet preview showing price impact ("buy moves probability 62% → 64%, payout if YES = $X") |
| Position constraints | UI prompts to exit opposite side first | One-tap "close + reverse" bundled-transaction button that sells the held side and buys the opposite in one signed action |
| Settlement countdown | Required | Live tick to 4:00 PM ET on every market card |
| Payoff display | *"You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]"* | Already-specified language; render verbatim |
| Portfolio | Entry price, current price, P&L, redeem button | Group positions by underlying; show realized vs unrealized; one-tap redeem-all after settlement |
| Oracle attribution | (not required) | [SHOULD] On every market card: "Settles via Pyth Network — AAPL/USD feed" with link to feed |
| One-click quick-bet | (not required) | [MAY] Manifold-style ▲/▼ on market cards firing a default-size order, with first-use confirm modal |
| Probability slider | (not required) | [MAY] For limit orders: drag to set "I'll buy YES up to 70%" instead of typing a limit price |
| Calibration scorecard | (not required) | [MAY] In Portfolio: Brier score by sector/stock — retention feature |

### 5.3 Position-constraint UX flow

**Trigger:** User on the Trade page clicks "Buy Yes" but already holds 50 No tokens for the same strike.

**UI prompt:**
> *"You currently hold 50 No tokens for AAPL > $230. To buy Yes, you must close your No position first."*
>
> **[ Close No + Buy Yes ]**  ←  one-tap bundled transaction
> **[ Cancel ]**

The bundled transaction is one signed action that:
1. Sells (or redeems-pair, depending on inventory) the 50 No tokens.
2. Submits a Buy Yes order at user's chosen price/size.

This honors the PRD constraint (user is shown the prompt; opposite-side persistent holding is prevented) via a guided two-step flow: close the held side, then buy the opposite — two back-to-back transactions (not atomic).

### 5.4 Wallet integration
- Connect via Phantom, Solflare, Backpack (standard Solana wallet adapter).
- USDC balance read on connect; refresh on every state-changing action.
- Transaction signing via wallet adapter; explicit display of action being signed.

### 5.5 User flow specifications (matches PRD User Stories §2.10 walkthroughs)

The frontend must implement six user flows. Each flow's exact step sequence is mandated by the PRD; enhancements are layered as [SHOULD].

**Flow 1 — Buy Yes (Bullish) [MUST]**
1. User connects wallet → sees USDC balance.
2. User browses active contracts grouped by ticker.
3. User selects "META > $680" → sees current Yes/No prices.
4. User places buy order (market or limit) on the order book.
5. Wallet prompts user to sign.
6. After execution, Yes balance appears in portfolio.
7. Implied No price ($1 − Yes price) is displayed.
8. **If user already holds No for this strike → UI prompts to sell No first.**

**Flow 2 — Buy No (Bearish) [MUST]**
1. First-class **"Buy No" button** (not secondary workflow).
2. UI shows No price = $1 − Yes ask.
3. **Market order:** atomic mint-pair + sell Yes at best bid → keep No → **one wallet approval only**.
4. **Limit order:** atomic mint-pair + post Yes as limit sell at user-chosen price; user holds both tokens until Yes sell fills.
5. After execution, No balance appears in portfolio.
6. **If user already holds Yes for this strike → UI prompts to sell Yes first.**

**Flow 3 — Sell Yes (Exit Bullish) [MUST]**
1. User selects Yes position, clicks "Sell Yes."
2. Sell order placed on ask side.
3. User receives USDC on fill.
4. Portfolio updates with realized P&L (entry vs sale).

**Flow 4 — Sell No (Exit Bearish) [MUST]**
1. User selects No position, clicks "Sell No."
2. Under the hood: buy Yes from ask side.
3. User holds Yes + No → can redeem for $1 **OR system handles close automatically** [MAY enhancement — auto-close uses `redeem_pair`].
4. Portfolio updates with realized P&L.
5. **UX abstraction:** to the user, this feels like selling No directly — the Yes-buy is hidden.

**Flow 5 — Settlement & Redemption [MUST]**
1. Settlement runs automatically at ~4:05 PM ET via automation service.
2. Settlement price + outcome (above/below strike) displayed per contract.
3. Winning tokens show $1.00 payout; losing tokens show $0.00.
4. User clicks **"Redeem"** → signs one transaction → tokens burn, USDC arrives in wallet.
5. Unredeemed tokens remain redeemable indefinitely.
6. [SHOULD] Auto-redeem default-on toggle (per Polymarket pattern) — opt-out in Settings.

**Flow 6 — Market Maker: Mint & Quote [MUST]**
1. MM deposits $1.00 USDC per pair → mints 1 Yes + 1 No.
2. MM posts limit orders for Yes on the order book.
3. MM sees exposure, fills, and P&L in dashboard/portfolio view.
4. [SHOULD] Dedicated `/mm` route with multi-strike inventory view, delta exposure summary, and one-click quoting helpers.

---

## 6. Automation service (Node.js + TypeScript)

Two scheduled jobs running US trading days only. Lives in the same repo as the smart contract and frontend.

### 6.1 Morning job (~8:00 AM ET)
For each of 7 stocks:
1. Read previous close from Pyth (off-chain API for speed).
2. Compute strikes at ±3/6/9%, rounded to nearest $10, deduplicated.
3. For each unique strike, call `create_strike_market` instruction with `(ticker, strike, expiry=today 4 PM ET)`.
4. Log results; alert on failure; retry with exponential backoff.

### 6.2 Settlement job (~4:05 PM ET)
For each open contract:
1. Call `settle_market`.
2. If Pyth confidence is too wide (instruction reverts), retry every 30 seconds for up to 15 minutes.
3. If still failing after 15 minutes, alert admin for manual `admin_settle_override` (which itself respects the 1-hour delay).

### 6.3 Operational details
- Single hot wallet for the automation service, funded with SOL for tx fees.
- Secrets via environment variables; `.env.example` committed.
- Logs to stdout + persistent file; structured JSON for parsing.
- Health-check endpoint for monitoring.

---

## 7. Order book strategy

Per PRD §3.2, two options exist: use an existing on-chain CLOB or build a minimal one. **Original choice: Phoenix V1.**

> **As shipped:** the second option was taken. Phoenix is not available on localnet/devnet, so Meridian ships a **minimal in-program CLOB** (`state/orderbook.rs` + `instructions/place_order.rs`): fixed-size (16) bid/ask arrays in an `OrderBook` PDA, match-on-place within a single transaction, escrow held by the market PDA. The §7.1 Phoenix-CPI design below is retained for historical context; substitute "in-program order book" wherever it says "Phoenix".

### 7.1 Phoenix integration (superseded — see build note above)
- One Phoenix market per (stock, strike, date) — Yes token traded against USDC.
- Meridian's smart contract calls Phoenix via CPI (Cross-Program Invocation) during `create_strike_market` to initialize the book.
- Order placement/cancellation/match goes directly through Phoenix instructions; Meridian's contract handles only mint/burn/settle.
- The "two perspectives" UX requirement is satisfied by frontend math: render the same Phoenix book showing Yes prices, and a flipped view showing No prices as `1.00 - yes_price` per level.

### 7.2 Liquidity bootstrapping
- Meridian operators may run an initial market-maker bot for the first weeks of operation — explicit deposit of $1 USDC mints a pair, then quote both sides on Phoenix.
- This is documented as "operator-provided initial liquidity" in the risks/limitations note (not a permanent backstop).

---

## 8. Risks and limitations (required by PRD §2.14)

To be drafted as a short markdown file `docs/RISKS.md`. Will explicitly note:
- **No regulatory or compliance claims.** This is a technology demonstration. Whether binary options on US equities can be legally offered to US persons via a decentralized non-custodial app is an unresolved regulatory question that this project does not engage.
- **Oracle dependency.** Settlement correctness is bounded by Pyth's correctness. A bad Pyth print at 4:00 PM ET could settle a market incorrectly; the admin override is the documented mitigation.
- **Order book bootstrap risk.** Markets with no market maker will have thin or empty books — users may be unable to enter/exit at reasonable prices. Operator-provided initial liquidity is a launch-phase mitigation.
- **Admin keys.** The admin authority can pause, settle-override, and add strikes. This is centralized trust. Documented as a known trade-off; a future version could migrate to a multisig or governance.
- **Stock market closure days.** Holidays, half-days, and unscheduled closures need handling. Automation should consult an NYSE calendar; the spec doesn't address this — flag for v2.
- **Capital-efficiency note on No-side trades.** Per the spec's `Buy No` flow (mint pair, sell Yes, keep No), users must hold ~$1 USDC of working capital to acquire a No position whose net cost is `1 − yes_ask`. Documented in the UX so users aren't surprised.

---

## 9. Deliverables checklist

Mapped directly to PRD success criteria (§2.13, §2.14):

- [ ] Solana devnet deployment with reproducible scripts.
- [ ] Smart contract program ID published in README.
- [ ] All 8 smart contract functions implemented and tested (initialize_config, create_strike_market, add_strike, mint_pair, settle_market, admin_settle_override, redeem, pause/unpause).
- [ ] Invariant tests passing: `Yes + No = $1` for all prices; vault balance = $1 × pairs minted after every operation.
- [ ] Oracle integration with staleness + confidence checks; admin override with enforced 1-hour delay.
- [ ] Frontend with all 5 required pages.
- [ ] All 4 trade paths functional (Buy Yes, Buy No, Sell Yes, Sell No) on the order book.
- [ ] Position constraints enforced in UI.
- [ ] Real-time order book display in both Yes and No perspectives.
- [ ] Settlement within 10 minutes of market close in the demo.
- [ ] Portfolio with entry price, current price, P&L, redeem.
- [ ] Automation service runs morning + settlement jobs.
- [ ] Integration test: full lifecycle on devnet end-to-end.
- [ ] Multi-user integration test (mint/quote/take/redeem).
- [ ] README with one-command setup.
- [ ] `.env.example` provided; no secrets committed.
- [ ] Risks/limitations document.
- [ ] Architecture decisions document explaining alternatives and trade-offs.

---

## 10. Build phases

| Phase | Scope | Duration target |
|---|---|---|
| **Phase 1 — Contract spine** | Anchor scaffold, ConfigAccount, MarketAccount, mint/burn primitives, Yes/No SPL mints, vault, USDC handling. Unit tests for mint_pair + redeem invariants. | ~2 days |
| **Phase 2 — Oracle + settle** | Pyth Pull integration, settle_market with staleness/confidence checks, admin_settle_override with time-delay enforcement. Tests for stale/wide/valid scenarios. | ~1 day |
| **Phase 3 — Order book** | Phoenix CPI integration in create_strike_market. Initialize Yes/USDC market per strike. Manual integration test placing/matching orders. | ~1.5 days |
| **Phase 4 — Automation** | Morning job (read close, generate strikes, create markets). Settlement job (call settle, retry logic, admin alerting). Devnet smoke test of full daily cycle. | ~1 day |
| **Phase 5 — Frontend** | Next.js scaffold, wallet adapter, 5 required pages, contract cards, order book display, trade panel, position-constraint UX, portfolio + redeem. | ~3 days |
| **Phase 6 — Integration tests + docs** | Multi-user E2E test on devnet, all 4 trade paths, README, risks doc, architecture decisions doc, `.env.example`. | ~1 day |
| **Phase 7 — Polish + bonus** | One-tap close+reverse bundled tx, oracle attribution on cards, [MAY] one-click quick-bet, [MAY] mainnet-beta deployment if time. | ~1.5 days |

Total target: ~11 days of focused work. Phases 1–3 are the critical path; phases 5 and 6 are the largest blocks.

---

## 11. Out of scope for V1 (explicitly)

- Multi-day expiries (weekly, monthly).
- Stocks outside the MAG7.
- Permissionless user-initiated market creation (only the daily automation creates markets).
- Native protocol token / governance / staking.
- AMM-style liquidity provision (we use only Phoenix CLOB).
- Mobile native apps (PWA via Next.js is sufficient).
- Cross-chain bridging.
- Dispute resolution layer (settlement is direct-oracle, not optimistic).

These are noted to set scope expectations; nothing here violates the PRD.

---

## 12. Open questions to confirm before locking the build

1. **Pyth coverage of all 7 MAG7 tickers.** AAPL, NVDA, TSLA explicitly confirmed in Pyth's announcements. MSFT, GOOGL, AMZN, META are implied as "mega-cap tech" but not enumerated. → Verify each feed exists on Solana devnet at `pyth.network/price-feeds` before locking Pyth as primary.
2. **Pyth equity feed availability on devnet.** Pyth's Solana mainnet has equity feeds; devnet coverage may be partial. Worst case: mock the oracle in devnet by writing a thin "MockPyth" account that returns scripted values, and use real Pyth on mainnet-beta only.
3. **"At-or-above" rule disambiguation.** PRD says Yes wins at-or-above ($230.00 closes → Yes wins for $230 strike). Verify Pyth's price granularity (typically 8 decimals); ensure rounding doesn't introduce off-by-one bugs.
4. **NYSE calendar source.** Need a reliable source for trading day calendar (holidays, half-days). Flag for automation service.
5. **Fee accrual destination.** PRD says fees go to a separate account from the vault. Need to define: protocol-owned account? Operator-owned? This is a deliberate operational choice to document.

---

## 13. Appendix — competitive research summary

(Full research synthesis available in conversation history; key takeaways inline above.)

- **Polymarket** — closest UX/architecture analog. Borrow: two-button Yes/No, price-as-probability display, auto-redeem default, CTF split/merge/redeem primitive. Avoid: UMA optimistic oracle (too slow for daily settlement).
- **Kalshi** — regulated comparison. Borrow: parabolic fee curve, source-agency labeling on cards, silent position netting (but PRD requires UI prompt — we honor PRD).
- **Augur v2** — lessons-learned. Avoid: long dispute windows, native protocol token, L1 gas costs, mechanism-design-over-UX trap. Single biggest takeaway: be pragmatic where principles don't matter to users.
- **Manifold** — UX innovation source. Borrow: one-click bet pattern (with confirm modal for real money), probability slider for limit orders, calibration scorecard.
- **Drift BET** — anti-model for settlement. Their multisig was compromised April 2026 for ~$285M. Validates our choice of autonomous Pyth oracle settlement over human-controlled fallback.

---

---

## 14. Peak6 appeal — strategic positioning

This section is the bridge between Meridian's technical design and the audience evaluating it. Meridian is being built for evaluation by Peak6 (Austin), so every PRD-permitted decision should be made — when there's ambiguity — in the direction Peak6 will instinctively value. This is not about changing the product; it's about framing, naming, additional deliverables on top of the PRD, and which language to use in docs/README/demo.

### 14.1 Who's evaluating this — the Peak6 ecosystem

**The firm.** Peak6 is a Chicago-founded (1997), Austin-headquartered-as-of-Jan-1-2025 multi-billion-dollar diversified financial services and technology holding company. Founders Matt Hulsizer and Jenny Just both trained at **O'Connor & Associates** — the legendary mathematician-founded Chicago options shop that produced Chicago Trading Co., Wolverine, and Peak6 itself. Hulsizer worked directly under risk management legend Clay Struve. Just was one of the first women on the CBOE options floor. They are **options market makers by lineage and identity**, not generalist quants.

**The Austin office is the center of gravity, not a satellite.** HQ relocated from Chicago to Austin December 2024 / effective January 1, 2025. Founders personally relocated and bought a stake in Austin FC. Austin is now Peak6's largest office and the home of engineering, AI, and the **Peak6 Trials** founder residency program ($100k salary, 12 months, ~1% acceptance, max 12 founders/year — Austin-based, fintech-focused).

**The portfolio matters more than the prop desk for Meridian's pitch.**
- **Peak6 Capital Management** — the original options market maker.
- **Apex Fintech Solutions** — clearing/custody backbone powering Robinhood, SoFi, Betterment, eToro, Webull, M1, Public, and (Feb 2026) Coinbase's "Everything Exchange." Currently filing for IPO. Peak6 retains minority stake; GTCR has the majority; State Street is a strategic investor (Oct 2025).
- **Apex Prediction Markets** — launching **Q2 2026**, turnkey CFTC-regulated event-contract infrastructure for fintechs. This is the single most important fact in this section. Peak6's flagship subsidiary is building Kalshi-style event-contract rails on regulated infrastructure *right now*.
- **Bruce Markets / Bruce ATS** — overnight US-equities ATS, FINRA/SEC approved March 2025, Sun–Thu 8pm–4am ET. Targets Asian retail flow on US single-name equities. The "new venue for new ways to trade" thesis.
- **Zero Hash** — Peak6 portfolio company, **$1.5B+ crypto-infrastructure unicorn** (May 2026 round). Proves they're long onchain financial infrastructure as an investment thesis.
- **Peak6 Capital is a Pyth Network data publisher on Solana mainnet since Feb 16, 2022** — alongside Jane Street, Jump Trading, Two Sigma, Virtu. Tom Simpson, CEO Peak6 Capital, on joining: *"We look forward to contributing to the success of DeFi and the fast-evolving transformation of the financial markets."*

**Gauntlet AI connection.** No publicly confirmed partnership, but circumstantial alignment is strong: both Austin-based, both AI-first, both run residency-style highly-selective programs. Gauntlet's own materials state "30+ hiring partners, some require sensitivity and aren't publicly disclosed." Peak6 fits that profile cleanly. Treat Meridian as a Gauntlet capstone that Peak6 will scrutinize as if hiring you onto AI Solutions or evaluating you for Trials.

### 14.2 Direct alignment signals already in Meridian's design

Without changing anything in the PRD-bound plan, Meridian already hits several Peak6 alignment points by virtue of its baseline design choices. These should be **explicitly called out** in the README and demo narrative:

| Meridian design choice | Peak6 alignment |
|---|---|
| **Pyth Network as primary oracle on Solana** | Peak6 *is* a Pyth publisher. Meridian consumes data that Peak6 helps produce. The pitch writes itself. |
| **Binary outcome contracts on US equities (MAG7)** | Peak6 Capital is a US equity options market maker. MAG7 single-name options are bread-and-butter underlyings. |
| **Yes + No = $1.00 model-risk-free invariant** | Cleanest expression of edge known to options traders. No vol surface needed. They will appreciate the rigor. |
| **Non-custodial architecture** | Peak6 sold Apex Crypto in 2023 specifically because of custody/regulatory risk ("there was too much risk" — Bill Capuzzi, Apex Fintech CEO). A non-custodial DEX removes the exact failure mode. |
| **Tech stack: Rust/Anchor + TypeScript/Next.js + Node.js** | Maps cleanly to Peak6's Austin engineering stack (Java/Go/Python/TS/React/Node + K8s/Kafka/Postgres). No C++ HFT heroics expected; Peak6 self-describes as "low-latency in the millis," not nanosecond arms race. |
| **CLOB-based order book (Phoenix V1)** | Polymarket migrated *away from* AMM pricing toward CLOB in 2023 for exactly the reasons options MMs prefer order books. Peak6 will recognize this. |
| **0DTE (zero-days-to-expiration) daily settlement** | 0DTE options are the fastest-growing segment of US equity options markets. Peak6 trades them. The product is current. |
| **Strike grid at ±3/6/9% around previous close** | Mirrors how equity options chains are quoted around at-the-money. Familiar territory. |

### 14.3 Framing and language — write everything as if a Peak6 trader is reading

**Adopt these terms in README, docs, and demo narrative:**

- **"Binary cash-or-nothing call option"** — not "Yes token" alone. First mention in README: *"Each Yes token is a digital cash-or-nothing call on [STOCK], strike K, expiry today's close. Price equals risk-neutral probability P(S_T ≥ K)."*
- **"Risk-neutral implied probability"** — not just "probability." The qualifier signals you understand the no-arbitrage framing.
- **"Market microstructure innovation"** — not "DeFi" or "Web3." Mirror Bruce ATS's launch language: *"raising the standard for execution."*
- **"Onchain venue for binary equity-close contracts"** — positions Meridian as a venue, the way Peak6 thinks about market structure.
- **"Capital-efficient market making"** — the Yes + No = $1 invariant means a quoter needs only $1 of collateral per pair. Call this out explicitly.
- **"Settlement determinism via institutional-grade price oracle"** — Pyth's publisher set (Jane Street, Jump, Peak6, Two Sigma, Virtu, Cboe) is the regulatory-credible backstop. Name them.
- **"Non-custodial = reduced regulatory surface"** — frame self-custody as a *risk-management feature*, not a crypto-purity choice.
- **"CFTC-aware design"** — even though we're not CFTC-registered (per PRD), demonstrate awareness of the regulated path Apex Prediction Markets is building.

**Avoid these terms / framings (Peak6 will read them as red flags):**

- ❌ "DeFi summer," "yield," "degens," "memecoin," "ape"
- ❌ "Polymarket competitor" (regulator-hostile positioning, politically toxic to Peak6's compliance posture)
- ❌ Anonymous/pseudonymous team posture
- ❌ "Gambling," "casino," "lottery" (Peak6 trades regulated derivatives; this framing taints serious derivatives products)
- ❌ Hand-waving on US user access or compliance
- ❌ "Decentralization for its own sake" — Peak6 values decentralization only when it solves a real risk problem
- ❌ Hype-heavy language; under-claim and demonstrate

### 14.4 New deliverables to add on top of the PRD

These are [SHOULD] / [MAY] enhancements that don't conflict with the PRD and would specifically impress a Peak6 evaluator. Prioritized by ROI:

1. **[SHOULD] `docs/FOR_OPTIONS_TRADERS.md`** — a 1–2 page document framing Meridian in derivatives language. Explicitly defines Yes/No tokens as binary cash-or-nothing options. Discusses Greeks honestly (delta ≈ 1−2·price, gamma is a delta-function at strike → pin risk, vega for non-zero time to expiry). Compares to traditional binary options markets. This is the cheapest, highest-signal addition possible.

2. **[SHOULD] Implied probability distribution (Breeden-Litzenberger style) on the Markets page.** Across the strike chain for a given underlying, the Yes prices trace a discrete risk-neutral CDF. The discrete derivative gives an implied PDF for S_T. Render this as a small histogram on each ticker's market page — *"Market-implied distribution of AAPL close today."* This is the **single most impressive thing a Gauntlet builder can put in front of an options trader.** Calls for ~50 lines of frontend code; pays for itself in evaluator-credibility many times over.

3. **[SHOULD] Settlement latency benchmark vs Polymarket / Kalshi** in the README. Measure and report: time from market close → settlement transaction on-chain → tokens redeemable. Solana finality is your structural advantage; quantify it. Peak6 benchmarks everything.

4. **[SHOULD] Capital efficiency worked example** in `docs/MARKET_MAKING.md`. *"Quoting both sides of the AAPL > $230 market with $1,000 of inventory: place 1,000 Yes asks at $0.65 and 1,000 No asks at $0.35 (= buy 1,000 Yes bids at $0.65). Maximum loss is bounded at $0; expected revenue is $X based on historical fill rates."* Make the MM economics legible.

5. **[SHOULD] Brier score dashboard for resolved markets.** After settlement, compute Brier score for each market (probability vs realized outcome). Display rolling Brier per underlying. Polymarket-grade calibration (Brier < 0.125) is the language Peak6 speaks. Lives in `/history` page.

6. **[MAY] Market-making quoter SDK** — a thin TypeScript module wrapping Phoenix order placement, exposing `quoteBothSides(market, midPrice, spread, size)`. Example script showing a basic delta-flat quoting strategy. Demonstrates platform usability for actual market-making firms — *like Peak6*.

7. **[MAY] Order book depth visualizer in Bloomberg-terminal style** on the Trade page. Vertical depth bars, time-and-sales tape, color-coded order flow. Pro-trader UI signals you respect the trader.

8. **[MAY] Historical backtest** — run the strike-chain pricing logic against 6 months of historical MAG7 closes; show that the implied PDF predicted realized outcomes reasonably (calibration error within bounds). This is the quantitative receipt.

9. **[MAY] Delta-hedge example** — a script that takes a Yes position on Meridian and opens an offsetting short on Drift Protocol's MAG7 perpetual (or a similar venue). Demonstrates the cross-venue hedging story options traders care about.

10. **[MAY] Position-monitoring webhook** — Apex/Peak6 lives in alerts and dashboards. A simple webhook firing on every fill, settlement, or unredeemed-position event makes the platform feel operational, not toylike.

### 14.5 README narrative — opening paragraph

Draft for the README's opening:

> **Meridian** is a non-custodial onchain venue for binary outcome contracts on US equity closes, built on Solana. Each contract is a digital cash-or-nothing call on a MAG7 stock — *"Will AAPL close at or above $230 today?"* — paying $1 USDC if Yes, $0 if No. Yes and No tokens sum to exactly $1.00 at all times, an invariant enforced on-chain.
>
> Markets are created automatically each morning at ±3/6/9% strikes around the previous close, traded intraday on a Phoenix V1 central limit order book, and settled at 4:00 PM ET against the Pyth Network's institutional equity price feed (Pyth's publisher set includes Jane Street, Jump, Two Sigma, Virtu, and Peak6 Capital Management itself). Settlement is autonomous when oracle freshness and confidence checks pass; an admin override exists as a documented fallback with a mandatory 1-hour delay.
>
> The product is a working demonstration of how onchain rails — sub-second finality, transparent state, institutional-grade oracles — can host capital-efficient binary derivatives on US equities without custodial exposure. We treat regulatory questions explicitly (see RISKS.md); this is a technology demonstration on Solana devnet, not a live offering to US persons.

Mirror Hulsizer/Just's *"in the business of what ought to be"* implicitly — show the product, don't quote the tagline. They will notice.

### 14.6 Demo script — what to show in order

If a Peak6 evaluator gets 5 minutes:

1. **30 seconds — the product.** Connect wallet → see live MAG7 strike grid → pick AAPL > $230 → place a Buy Yes for 10 contracts. One signature, sub-second fill.
2. **45 seconds — the implied distribution.** Switch to the implied-PDF view on AAPL. Show how the strike chain prices reveal a market-consensus distribution. Identify the implied mean and the implied 1-day vol.
3. **45 seconds — the order book mechanics.** Show the Phoenix CLOB with both Yes and No perspectives. Demonstrate Buy No → silent mint-pair + sell-Yes happens atomically. Show the position-constraint UX (try to Buy No while holding Yes → bundled close+reverse prompt).
4. **60 seconds — settlement.** Trigger a manual settle on a test market. Show: oracle read, freshness check, confidence check, outcome written, tokens redeemable. Quote the settlement latency from market close.
5. **45 seconds — the Brier scorecard.** Show calibration across all settled markets — predicted probability vs realized outcome. Implied accuracy.
6. **45 seconds — the architecture diagram + readme.** Talk through: Phoenix for CLOB (why crankless matters at 4pm), Pyth for oracle (why publisher set matters), autonomous settlement (why this is materially safer than Drift's multisig that was compromised for $285M in April 2026), non-custodial vault (no Apex Crypto failure mode).
7. **30 seconds — the close.** *"This is the onchain expression of what Apex Prediction Markets is launching this quarter, with three differences: non-custodial, sub-second finality, and powered by the Pyth feeds Peak6 already publishes."*

### 14.7 Tactical recommendations on the team's posture

- **Sign the demo and READMEs with your real name.** Peak6 hires people, not anons. The Trials program is name-on-the-line. Match the posture.
- **Reference the engineering culture in the docs.** Cite the CTO Palak Jain Built-in-Chicago interview; cite the Peak6 Engineering Medium "Pricing Parable" post — show you've read what they publish.
- **Acknowledge what you didn't build.** Peak6's culture values intellectual honesty; a clearly-scoped "what we left out and why" section beats over-claiming. The Risks doc is the natural home for this.
- **Lead with regulatory engagement, not regulatory avoidance.** A short paragraph in RISKS.md that says *"Binary options on US equities are a regulatorily contested category — CFTC vs SEC jurisdiction has been debated; the offshore binary options industry has a fraud-tainted history. This project is a technology demonstration on devnet and explicitly does not offer markets to US persons. The Apex Prediction Markets approach — CFTC-registered FCM infrastructure — is the regulated path; this project's contribution is showing the non-custodial, onchain equivalent of that pattern."* signals adult engagement with the hard part.

### 14.8 What success looks like in the Peak6 reading

A Peak6 evaluator finishes the demo and thinks one of:
- *"This person could build the onchain version of Apex Prediction Markets."* — best case
- *"This person would fit Peak6 Trials and we should fund them."* — even better
- *"This person understands market microstructure, not just code."* — sufficient

To get to any of those, every deliverable above is in service of three signals: **(1) real engineering depth** (the Anchor program, the Phoenix integration, the test invariants), **(2) financial sophistication** (the Greeks discussion, the implied PDF, the Brier score), **(3) product polish + distribution thinking** (the README narrative, the demo flow, the for-options-traders doc). Roughly weighted 35/40/25 per Peak6 Trials' own stated values.

---

---

## 15. Features catalog — exhaustive

Every distinct feature in Meridian, tagged with PRD-status. Every feature listed here will be referenced as a work unit in `CODING_PRD.md`.

### 15.1 Smart contract features
| # | Feature | Status | Source |
|---|---|---|---|
| F-SC-01 | Global config initialization | [MUST] | PRD §2.5 |
| F-SC-02 | Per-strike market creation (one Yes mint + one No mint + vault + Phoenix book) | [MUST] | PRD §2.5 |
| F-SC-03 | Admin intraday strike add | [MUST] | PRD §2.5 |
| F-SC-04 | Mint pair (1 USDC → 1 Yes + 1 No) | [MUST] | PRD §2.5 |
| F-SC-05 | Redeem pair pre-settlement (1 Yes + 1 No → 1 USDC) | [SHOULD] | Needed for Sell-No auto-close (PRD §2.10) |
| F-SC-06 | Settle market via Pyth oracle (with freshness + confidence checks) | [MUST] | PRD §2.5, §2.7 |
| F-SC-07 | Admin settle override with mandatory 1-hour delay | [MUST] | PRD §2.5 |
| F-SC-08 | Redeem (post-settlement) | [MUST] | PRD §2.5 |
| F-SC-09 | Pause / unpause | [MUST] | PRD §2.5 |
| F-SC-10 | On-chain invariant enforcement (vault = $1 × pairs; Yes+No = $1; etc.) | [MUST] | PRD §2.6 |
| F-SC-11 | Fees routed to separate account (not vault) | [MUST] | PRD §2.6 |
| F-SC-12 | Settlement outcome immutability | [MUST] | PRD §2.6 |
| F-SC-13 | Fee taker rebate routing (parabolic curve) | [SHOULD] | Plan §3 |

### 15.2 Automation service features
| # | Feature | Status | Source |
|---|---|---|---|
| F-AS-01 | Morning job: read previous close, compute strikes, create markets | [MUST] | PRD §2.11 |
| F-AS-02 | Settlement job: call settle_market for every open contract at 4:05 PM ET | [MUST] | PRD §2.11 |
| F-AS-03 | Settlement retry: every 30s for up to 15min on wide confidence | [MUST] | PRD §2.11 |
| F-AS-04 | Alert admin on persistent failure | [MUST] | PRD §2.11 |
| F-AS-05 | NYSE trading-day calendar (skip non-trading days) | [SHOULD] | PRD §2.4 implicit |
| F-AS-06 | Health-check endpoint | [SHOULD] | Plan §6.3 |
| F-AS-07 | Structured logging | [SHOULD] | Plan §6.3 |
| F-AS-08 | Webhook on critical events | [MAY] | Plan §14.4 |

### 15.3 Frontend features — by page
**Landing** (`/`)
| # | Feature | Status |
|---|---|---|
| F-FE-LD-01 | Product explanation copy | [MUST] |
| F-FE-LD-02 | Live MAG7 ticker strip | [MUST] |
| F-FE-LD-03 | "Connect Wallet" CTA | [MUST] |
| F-FE-LD-04 | "Browse Markets" CTA → `/markets` | [MUST] |
| F-FE-LD-05 | Footer with links (docs, risks, github) | [SHOULD] |

**Markets** (`/markets`)
| # | Feature | Status |
|---|---|---|
| F-FE-MK-01 | Grid of 7 stocks (cards), live last-trade price + active contracts count | [MUST] |
| F-FE-MK-02 | Group cards by ticker | [MUST] |
| F-FE-MK-03 | Card click → `/trade/[ticker]` | [MUST] |
| F-FE-MK-04 | Settlement countdown timer (global, sticky) | [MUST] |
| F-FE-MK-05 | Search/filter | [SHOULD] |
| F-FE-MK-06 | Sort (by volume, by close-distance, alphabetical) | [SHOULD] |
| F-FE-MK-07 | "Featured" / "Trending" carousel (Polymarket-pattern) | [MAY] |

**Trade** (`/trade/[ticker]/[strike]` — and `/trade/[ticker]` defaulting to ATM strike)
| # | Feature | Status |
|---|---|---|
| F-FE-TR-01 | Strike list (left rail) with live Yes/No prices, current selection highlight | [MUST] |
| F-FE-TR-02 | Real-time order book — Yes perspective | [MUST] |
| F-FE-TR-03 | Real-time order book — No perspective (flipped: `1 − yes_price`) | [MUST] |
| F-FE-TR-04 | Perspective toggle (Yes view ⇄ No view) | [MUST] |
| F-FE-TR-05 | Trade panel with 4 buttons (Buy Yes / Buy No / Sell Yes / Sell No) | [MUST] |
| F-FE-TR-06 | Position-constraint enforcement on each button | [MUST] |
| F-FE-TR-07 | Order type toggle (market / limit) | [MUST] |
| F-FE-TR-08 | Quantity input with $ amount + share count auto-conversion | [MUST] |
| F-FE-TR-09 | Limit price input with probability slider (snap to 5% increments) | [SHOULD] |
| F-FE-TR-10 | Bet preview: avg fill price, payout if win, price impact, fees | [SHOULD] |
| F-FE-TR-11 | Payoff display string: *"You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]."* | [MUST] |
| F-FE-TR-12 | Recent trades tape (sliding window) | [SHOULD] |
| F-FE-TR-13 | Implied probability distribution (Breeden-Litzenberger) across the strike chain | [SHOULD] (Peak6 appeal §14.4) |
| F-FE-TR-14 | Oracle attribution chip ("Settles via Pyth — AAPL/USD") | [SHOULD] |
| F-FE-TR-15 | Settlement countdown (per-strike) | [MUST] |
| F-FE-TR-16 | Buy No first-class button (atomic mint+sell, one wallet approval) | [MUST] |
| F-FE-TR-17 | Sell No abstraction (atomic buy-Yes + redeem-pair, hidden mechanic) | [MUST] |

**Portfolio** (`/portfolio`)
| # | Feature | Status |
|---|---|---|
| F-FE-PO-01 | Active positions list grouped by underlying | [MUST] |
| F-FE-PO-02 | Per-position: entry price, current price, P&L | [MUST] |
| F-FE-PO-03 | Per-position: Sell button (goes to Trade with prefilled close intent) | [MUST] |
| F-FE-PO-04 | Settled outcomes list with $1.00 / $0.00 payout indicator | [MUST] |
| F-FE-PO-05 | Per-settled: Redeem button | [MUST] |
| F-FE-PO-06 | "Redeem All" bulk button | [SHOULD] |
| F-FE-PO-07 | Realized vs unrealized P&L summary card | [SHOULD] |
| F-FE-PO-08 | Auto-redeem toggle (Settings sub-section) | [SHOULD] |
| F-FE-PO-09 | Calibration scorecard (Brier score by ticker/sector) | [SHOULD] (Peak6 §14.4) |
| F-FE-PO-10 | Export positions CSV | [MAY] |
| F-FE-PO-11 | Market-maker dashboard view at `/portfolio/mm` (inventory, exposure, fills) | [SHOULD] (PRD §2.10 MM story) |

**History** (`/history`)
| # | Feature | Status |
|---|---|---|
| F-FE-HI-01 | Trade execution log (paginated) | [MUST] |
| F-FE-HI-02 | Per-row: tx signature link to Solana explorer | [MUST] |
| F-FE-HI-03 | Filter by date range, ticker, side, status | [SHOULD] |
| F-FE-HI-04 | Search by tx sig or market | [SHOULD] |
| F-FE-HI-05 | Export CSV | [MAY] |

**Cross-cutting** (header / footer / global)
| # | Feature | Status |
|---|---|---|
| F-FE-XC-01 | Header: nav links (Markets, Trade, Portfolio, History) | [MUST] |
| F-FE-XC-02 | Header: wallet connect button → opens wallet modal | [MUST] |
| F-FE-XC-03 | Header: USDC balance chip (post-connect) | [MUST] |
| F-FE-XC-04 | Header: network indicator (devnet / mainnet pill) | [SHOULD] |
| F-FE-XC-05 | Global toast/notification system | [MUST] |
| F-FE-XC-06 | Settlement countdown banner (sticky, global) | [SHOULD] |
| F-FE-XC-07 | Error boundary with friendly fallback | [SHOULD] |
| F-FE-XC-08 | Loading skeletons on every async view | [SHOULD] |
| F-FE-XC-09 | Settings panel (auto-redeem default, slippage tolerance, theme) | [SHOULD] |

---

## 16. Per-page specifications

Each page below has: **purpose**, **layout** (regions), **elements within each region**, **states** (initial / loading / error / empty), **all interactions**.

### 16.1 Landing page (`/`)

**Purpose:** First-time visitor sees what Meridian is and connects a wallet.

**Layout regions (top → bottom):**
- Header (global, see §16.6)
- Hero (full-bleed): tagline, sub-tagline, primary CTA, secondary CTA
- Live ticker strip (MAG7 last prices, scrolling)
- "How it works" (3-step illustrated explanation)
- Footer

**Elements & interactions:**
| Element | Type | Action |
|---|---|---|
| Hero tagline | text | static: *"Binary stock outcomes. On chain. Settled at the close."* |
| Hero sub-tagline | text | static: *"Trade Yes/No tokens on whether MAG7 stocks close above today's strike. Non-custodial. Pyth-powered."* |
| "Connect Wallet" CTA | button | → opens wallet modal (§17.1); on success, redirects to `/markets` |
| "Browse Markets" CTA | button | → `/markets` (no wallet required to browse) |
| Ticker strip | row of chips | auto-scrolls; each chip shows symbol + last price + change %; chip click → `/markets#<TICKER>` |
| "How it works" steps | static panels | non-interactive |
| Footer links | anchors | → docs, RISKS.md, github, twitter |

**States:**
- Initial: hero + ticker strip render; ticker shows skeleton until first Pyth fetch
- Loading: ticker skeletons
- Error: ticker strip shows "—" per cell; non-blocking
- No wallet detected (no extension installed): wallet modal shows install links

### 16.2 Markets page (`/markets`)

**Purpose:** Browse all live markets; pick a stock to trade.

**Layout:**
- Header
- Sticky sub-header: search input, sort dropdown, settlement countdown
- Grid of 7 stock cards (responsive: 1 col mobile, 2 col tablet, 3-4 col desktop)
- Within each card: per-strike list (collapsed by default; click chevron to expand)
- Footer

**Per-card elements:**
| Element | Action |
|---|---|
| Ticker symbol + company name | static |
| Last underlying price (live, Pyth) | auto-updates |
| Active contracts count (e.g., "5 strikes") | static |
| Expand chevron | toggles inline strike list |
| Card body click | → `/trade/[ticker]` (defaults to ATM strike) |

**Per-strike row (within expanded card):**
| Element | Action |
|---|---|
| Strike price (e.g., "$220") | label |
| Yes price | live; click → `/trade/[ticker]/[strike]` |
| No price (computed = 1 − Yes) | live; click → same |
| Volume today | static |
| Settlement countdown | live |

**Top-bar elements:**
| Element | Action |
|---|---|
| Search input | filters cards by ticker symbol/name |
| Sort dropdown | options: "Alphabetical" / "Volume" / "Closest to strike" |
| Refresh icon | manual refetch |
| Settlement countdown | live "Markets settle in 5h 23m" |

**States:**
- Initial: 7 cards render with skeleton prices
- Loading prices: per-card skeleton on price field
- Markets not yet created (pre-9:00 AM ET): empty state per card with copy: *"Markets open at 9:00 AM ET"*
- Markets settled (post-4:05 PM ET): cards show "Settled" badge with outcome
- Error fetching: per-card error chip, retry button

### 16.3 Trade page (`/trade/[ticker]/[strike]`)

**Purpose:** Take a position on a specific (ticker, strike) market.

**Layout (3-column desktop, stacked mobile):**
- Left rail: strike list for this ticker (~7 strikes)
- Center: order book + recent trades + implied-distribution chart
- Right rail: trade panel + position summary

**Strike list (left rail):**
| Element | Action |
|---|---|
| Strike row (one per available strike) | click → updates URL to `/trade/[ticker]/[strike]`, re-renders center/right |
| Highlighted current strike | visual selection state |
| Per-row: strike, Yes price, No price, volume | live |

**Center column:**
| Element | Action |
|---|---|
| Perspective toggle (Yes / No) | toggle button; flips the order book display |
| Order book (asks above, bids below) | live; click on a level pre-fills limit price in trade panel |
| Order book "depth bar" hover | tooltip: cumulative shares + USDC |
| Recent trades tape (last 50) | live; click row → Solana explorer link |
| Implied probability chart | renders implied PDF across strike chain (Breeden-Litzenberger) |
| Oracle attribution chip | static: "Settles via Pyth — AAPL/USD"; click → pyth feed page |

**Right rail — trade panel:**
| Element | Action |
|---|---|
| Side buttons: [Buy Yes] [Buy No] [Sell Yes] [Sell No] | each: sets the side, shows position-constraint check (§17.2 modal if needed), opens order ticket |
| Order type tabs: Market / Limit | switches between market and limit entry |
| Quantity input ($ amount) | text input + slider; auto-computes share count |
| Quantity input (shares) | alt input; auto-computes $ amount |
| Limit price (limit orders only) | text input + probability slider (snaps to 5% increments) |
| Bet preview panel | shows: avg fill price, max payout, max loss, fees, price impact |
| Payoff display string | live: *"You pay $X. You win $1.00 if [STOCK] closes above [STRIKE]."* |
| Submit button | label: "Buy Yes for $X" etc.; on click → builds tx → wallet signature → submits |
| Cancel button | clears the panel |
| Insufficient balance state | submit disabled, copy: "Insufficient USDC" + Get USDC link |
| Not-connected state | submit replaced by "Connect Wallet" |

**Position summary (right rail, below trade panel):**
- Shows current Yes/No balance for this strike (if any)
- "View in Portfolio" link
- Quick-sell button for held side (if any)

**States:**
- Initial / no wallet: order book renders read-only, trade panel shows "Connect to trade"
- Connected, no position: trade panel fully active
- Connected, holding opposite side: trade panel shows constraint warning, only same-side or close+reverse offered
- Market settled: trade panel replaced by settlement banner + redeem link

### 16.4 Portfolio page (`/portfolio`)

**Purpose:** See your positions, P&L, and redeem winnings.

**Layout:**
- Header
- Summary cards (top row): Total Value, Unrealized P&L, Realized P&L (today), Open positions count
- Tabs: Active / Settled / All
- Position list (grouped by underlying)
- Settings sub-section at bottom: Auto-redeem toggle, default slippage

**Active position row:**
| Field | Source |
|---|---|
| Ticker + strike | from token mint metadata |
| Side (Yes/No) | from which mint user holds |
| Quantity | wallet balance |
| Entry price | from on-chain trade history (avg) |
| Current price | live order book mid |
| Unrealized P&L (USDC + %) | computed |
| Settlement countdown | live |
| Sell button | → `/trade/[ticker]/[strike]` with prefilled close intent |
| Detail link | → expanded row with trade history |

**Settled position row:**
| Field | Source |
|---|---|
| Ticker + strike | mint metadata |
| Outcome | from market account |
| Your payout | $1 × winning balance + $0 × losing balance |
| Redeem button | builds redeem tx for this market |
| Settled timestamp | from market account |

**Top buttons:**
| Element | Action |
|---|---|
| Redeem All | iterates settled positions, builds batched redeem txs, prompts one signature per tx (or one if Solana supports batched sign) |
| Export CSV | downloads positions snapshot |
| Refresh | manual refetch |

**Calibration scorecard (Peak6 §14.4):**
- Brier score by ticker (rolling 30d)
- Calibration chart (predicted prob bucket vs realized rate)

**States:**
- No wallet: empty state with "Connect Wallet" CTA
- Connected, no positions: empty state with "Browse Markets" CTA
- Loading: skeleton rows
- Error: retry banner

### 16.5 History page (`/history`)

**Purpose:** Audit trail of every trade and settlement event.

**Layout:**
- Header
- Filter bar: date range, ticker dropdown, side dropdown, status dropdown, search box
- Paginated event list (50 per page)
- Footer

**Per-row fields:**
| Field |
|---|
| Timestamp |
| Event type (Buy/Sell/Mint/Redeem/Settle) |
| Ticker + strike |
| Side |
| Quantity |
| Price |
| Fee paid |
| Tx signature (click → Solana explorer in new tab) |
| Status (filled/cancelled/failed) |

**States:**
- No wallet: empty state
- No history: empty state with "Make your first trade" CTA
- Loading: skeleton rows
- Page navigation: numbered pagination + next/prev

### 16.6 Header (global)

| Element | Action |
|---|---|
| Logo | → `/` |
| "Markets" nav link | → `/markets`; active state when on /markets |
| "Trade" nav link | → `/trade/[lastVisitedTicker]` or default to first ticker |
| "Portfolio" nav link | → `/portfolio` |
| "History" nav link | → `/history` |
| Wallet button (disconnected) | → opens wallet modal (§17.1) |
| Wallet chip (connected): shortened pubkey + USDC balance | → opens wallet menu (copy address / view in explorer / disconnect) |
| Network indicator pill (devnet / localnet / mainnet) | static visual |
| Settings cog | → opens settings panel (§17.4) |

### 16.7 Footer (global)

| Element | Action |
|---|---|
| "Docs" link | → docs site |
| "Risks" link | → docs/RISKS.md |
| "GitHub" link | → repo |
| "How it works" link | → `/` + scroll to "How it works" |
| Version stamp | static |

---

## 17. Modal & dialog catalog

Every modal/dialog: trigger, content, action buttons, dismissal.

### 17.1 Wallet connect modal

**Trigger:** Header "Connect Wallet" button; "Connect to trade" CTA on Trade page; any action requiring a wallet when none is connected.

**Content:** List of supported wallets — Phantom, Solflare, Backpack — each as a clickable row with icon + name + "Install" link if not detected.

**Actions:** Click a wallet → triggers wallet adapter's connect flow → on success: close modal + dispatch global state update. On user reject: close modal silently. On error: error toast.

**Dismissal:** X button, click outside, ESC key.

### 17.2 Position-constraint modal

**Trigger:** User clicks Buy Yes while holding No (or Buy No while holding Yes) for the same strike.

**Content:**
> *"You currently hold [N] [No/Yes] tokens for [TICKER] > $[STRIKE]. To buy [Yes/No], you must close your [No/Yes] position first."*
>
> Two options:
> - **Close [No/Yes] + Buy [Yes/No]** — two back-to-back transactions (sell, then buy; NOT atomic)
> - **Cancel** — go back to trade panel unchanged

**Actions:**
- "Close + Buy" → builds composite tx (sell-then-buy or redeem-pair-then-buy), single wallet signature, executes atomically
- "Cancel" → closes modal

**Dismissal:** Cancel button, click outside, ESC.

### 17.3 Confirm-trade modal (first use)

**Trigger:** Submit button on Trade panel, *only* the first 3 trades a user makes (then auto-confirmed thereafter unless they opt back in via settings).

**Content:** Recap of the trade — side, quantity, price, total cost, max payout, fees, settlement time.

**Actions:**
- "Confirm" → proceeds to wallet signing
- "Cancel" → returns to trade panel
- "Don't show again" checkbox → persists preference

### 17.4 Settings panel (slide-over)

**Trigger:** Header cog icon.

**Content & toggles:**
- Auto-redeem after settlement (default ON)
- Confirm-trade modal (default ON for first 3 trades)
- Default slippage tolerance (numeric input, default 1%)
- Theme: System / Light / Dark
- Network: devnet / mainnet (read-only display unless multiple supported)

**Actions:** Each toggle/input saves immediately to localStorage. Footer: "Reset to defaults" button.

### 17.5 Redeem confirmation modal

**Trigger:** Single "Redeem" or bulk "Redeem All" button.

**Content:** List of positions to redeem with payout totals; "Total USDC you'll receive: $X.XX".

**Actions:**
- "Confirm Redeem" → builds tx(s), single signature each, executes
- "Cancel"

### 17.6 Settlement notification toast (auto-dismiss 10s)

**Trigger:** A market the user holds settles.

**Content:** *"[TICKER] > $[STRIKE] settled at $X.XX — [Yes/No] wins. You won $Y.YY."*

**Actions:**
- "Redeem now" → opens redeem modal pre-filled
- Auto-dismiss

### 17.7 Error toasts

**Triggers:** Tx failure, wallet rejection, network error, insufficient balance, oracle stale.

**Pattern:** Red banner, clear error message, optional action (e.g., "Retry", "Get USDC").

---

## 18. Cross-cutting UI concerns

### 18.1 Loading states
- Every async data fetch must render a skeleton, never a spinner-only state.
- Skeletons match the eventual layout shape (rows, cards, chart placeholders).
- Stale data fades to half-opacity during refetch; never blanked.

### 18.2 Empty states
- Every list view: bespoke empty state with illustration + copy + primary CTA.
- "No positions yet" → "Browse Markets" CTA.
- "No history yet" → "Make your first trade" CTA.
- "Markets not yet open" → settlement countdown to 9:00 AM ET.

### 18.3 Error boundaries
- Top-level error boundary catches React crashes; shows fallback page with "Reload" + Sentry tag.
- Per-section boundaries on Trade page (order book, trade panel, chart) so one widget crash doesn't take the page down.

### 18.4 Notification system
- Toast notifications: positioned bottom-right desktop, top mobile.
- Types: info / success / warning / error.
- Auto-dismiss: info 5s, success 5s, warning 8s, error sticky.
- Stack vertically; max 4 visible.

### 18.5 Wallet adapter integration
- Use `@solana/wallet-adapter-react` + `@solana/wallet-adapter-react-ui` + adapters for Phantom, Solflare, Backpack.
- Wrapping `<WalletProvider />` at app root.
- Auto-reconnect on page load if previously connected.

### 18.6 Number formatting
- Prices: 2 decimals, always show ¢ ("$0.65" or "65¢" depending on context).
- Probabilities: integer percent ("65%").
- USDC amounts: 2 decimals ("$12.34").
- Counts: integer with locale separators ("1,234 shares").

### 18.7 Time formatting
- Settlement countdown: "5h 23m" until 1h remaining, then "0:23:14" countdown.
- Trade timestamps: relative ("3 minutes ago") until 24h, then absolute ("Mar 14, 11:23 AM ET").

---

## 19. State-machine diagrams — critical flows

### 19.1 Mint-pair flow (user clicks "Buy No" via mint-pair-and-sell path)
```
[Idle] --click Buy No--> [PositionCheck]
[PositionCheck] --user holds Yes--> [PromptCloseModal]
[PositionCheck] --no Yes held--> [TicketOpen]
[PromptCloseModal] --Close+Buy--> [BuildCompositeTx]
[PromptCloseModal] --Cancel--> [Idle]
[TicketOpen] --user enters qty--> [BuildMintPairTx]
[BuildMintPairTx] --tx built--> [WalletSign]
[WalletSign] --user signs--> [Submitting]
[WalletSign] --user rejects--> [TicketOpen]
[Submitting] --tx confirmed--> [Success]
[Submitting] --tx failed--> [ErrorToast]
[Success] --auto-update portfolio--> [Idle]
```

### 19.2 Settlement flow (automation)
```
[Pending] --4:05 PM ET cron--> [ReadPyth]
[ReadPyth] --price ok--> [ValidateChecks]
[ReadPyth] --pyth unreachable--> [Retry]
[ValidateChecks] --staleness ok + confidence ok--> [SubmitSettle]
[ValidateChecks] --stale or wide--> [Retry]
[Retry] --< 15 min elapsed--> [ReadPyth]
[Retry] --> 15 min elapsed--> [AlertAdmin]
[SubmitSettle] --tx confirmed--> [Settled]
[SubmitSettle] --tx failed--> [Retry]
[AlertAdmin] --admin runs override after 1h delay--> [Settled]
[Settled] --emit event--> [End]
```

### 19.3 Redeem flow
```
[SettledPosition] --user clicks Redeem--> [BuildRedeemTx]
[BuildRedeemTx] --> [WalletSign]
[WalletSign] --signed--> [Submitting]
[Submitting] --confirmed--> [USDCReceived]
[Submitting] --failed--> [ErrorToast]
[USDCReceived] --update balance + portfolio--> [Cleared]
```

---

## 20. Error handling & recovery — exhaustive

| Error class | UX response | Recovery action |
|---|---|---|
| Wallet not connected when required | Header CTA + disabled submits | User clicks Connect → §17.1 |
| User rejected tx signature | Silent close of signing modal; toast: "Transaction cancelled" | None — return to form |
| Insufficient USDC | Submit disabled, inline error with "Get USDC" link | Link to devnet faucet |
| Insufficient SOL for gas | Submit disabled, inline error "Need ~0.001 SOL for gas" | Link to airdrop |
| Network RPC timeout | Toast: "Network slow — retry in 5s" | Auto-retry with backoff |
| Tx simulation failed | Toast with parsed program error message | Form re-renders with hint |
| Phoenix market not found / not yet created | Disable trade panel, copy: "Market opens at 9:00 AM ET" | Wait |
| Oracle stale at settlement time | Banner on Trade page: "Settlement delayed — oracle re-checking" | Automation retries; admin override if persistent |
| Position constraint violation | Modal §17.2 | Bundled close+reverse |
| Already settled, can't trade | Replace trade panel with settlement banner + redeem CTA | User redeems |
| Auto-redeem failed | Per-position error indicator, manual redeem button | User retries manually |

---

*End of plan v1. Living document — revise as build proceeds. See `CODING_PRD.md` for the parallel-swarm work breakdown.*
