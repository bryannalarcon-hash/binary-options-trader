# Meridian — Risks and Limitations

This document is the PRD §2.14 deliverable: a clear, honest accounting of what Meridian is *not*, what could go wrong, and what the documented mitigations look like. Meridian is a technology demonstration on Solana devnet. It is not an offering of financial products. Read this section before drawing any conclusions about what the project is suitable for.

---

## 1. No regulatory or compliance claims

**Meridian makes no regulatory or compliance claims of any kind.** Whether binary options on US equities can legally be offered to US persons via a non-custodial decentralized application is an unresolved regulatory question that this project does not engage. CFTC vs SEC jurisdiction over event contracts on single-name equities is actively disputed (the *KalshiEX* litigation, the CFTC's 2022 *Polymarket* settlement, and the offshore-binary-options fraud history together describe a category that regulators treat with great suspicion).

This project's contribution is *technical*: it shows the non-custodial, on-chain equivalent of the regulated pattern that Apex Prediction Markets (a Peak6 portfolio company) is building under CFTC FCM rails. The regulated path and the non-custodial path are complementary; this project demonstrates the second.

**The deployment is for evaluation only.** It runs on a local Solana validator (localnet; an optional devnet deploy exists for a public demo), is not promoted, marketed, or made available to US persons as a financial product, and uses synthetic test USDC with no mainnet value. No real-money funds are ever at risk.

---

## 2. Oracle dependency

Settlement correctness is bounded by the correctness of the price oracle. Meridian uses Pyth Network as the canonical price source.

**What can go wrong:**
- A bad Pyth print at 4:00 PM ET (publisher outage, network anomaly, aggregator stalling) could settle a market against the wrong side.
- Pyth confidence bands can widen during volatile events (earnings, halts); the on-chain staleness + confidence checks in `settle_market` will then revert and gate settlement.
- An attacker who corrupted multiple Pyth publishers simultaneously could manipulate settlement. Pyth's publisher set (Jane Street, Jump, Two Sigma, Virtu, Cboe, Peak6 Capital) makes this expensive but not impossible.

**Documented mitigation:**
- On-chain freshness check: `settle_market` rejects any oracle update older than the configured threshold (currently 60 seconds).
- On-chain confidence check: `settle_market` rejects updates whose Pyth confidence band exceeds the configured threshold (configurable per market).
- `admin_settle_override` is the fallback when oracle conditions fail for an extended period (15-minute automation retry window). The override is gated by an on-chain time-delay check (`expiry_ts + 3600 ≤ now`) so an admin cannot front-run an oracle-based settlement.
- See [IMPLEMENTATION_PLAN.md §2.7](IMPLEMENTATION_PLAN.md) and §4.3 for the precise enforcement.

**Oracle architecture note (read this carefully).** The demo does **not** use the Pyth Receiver pull-update pattern (`update_price_feeds` CPI) end-to-end. Instead, the automation service polls Pyth Hermes (the HTTP API) every 30 seconds and pushes the price into the program's `OracleAccount` via an `update_oracle` instruction. This is a deliberate architectural simplification for the demo:
- Avoids per-update receiver costs (~5k lamports each, paid by the admin wallet — already a small operational pain point even at 30 s cadence).
- Avoids the devnet Pyth Receiver setup, which is patchier than mainnet.
- Trade-off: trust shifts from "Pyth Receiver attestation" to "automation service + admin keypair." The on-chain `settle_market` still validates freshness + confidence, so a stale or wide reading is still rejected — but the upstream attestation chain is shorter on devnet than it would be on mainnet.

For a mainnet deployment, the natural path is to swap the `OracleAccount` pattern for direct `PriceUpdateV2` reads via Pyth Receiver, removing the automation service from the settlement critical path entirely.

---

## 3. Order book bootstrap risk

Meridian uses a custom on-chain CLOB (zero-copy `OrderBook` PDA, slot-based price levels, sweep matching in the client). Like every CLOB on every venue ever, **markets with no market maker have thin or empty books**. New users may be unable to enter or exit at reasonable prices in the first hours of any new strike.

**What can go wrong:**
- A user clicks "Buy Yes" on a market with no asks; the order rests as a bid and may never fill before expiry.
- Mid-prices computed from an empty book are unreliable; portfolio P&L approximations (which use mid-price as a proxy for "current price") will look off until trades happen.
- Slippage on small books can be severe; a $50 market order might walk through several cents of spread.

**Documented mitigation:**
- **Operator-provided initial liquidity.** Meridian operators are expected to run an initial market-maker bot for the first weeks of operation: deposit $1 USDC per pair via `mint_pair`, then post bids and asks on both sides via `place_order`. This is documented as "operator-provided initial liquidity" in [IMPLEMENTATION_PLAN.md §7.2](IMPLEMENTATION_PLAN.md). It is a launch-phase mitigation, not a permanent backstop.
- See [docs/MARKET_MAKING.md](MARKET_MAKING.md) for the worked MM example and capital requirements.

---

## 4. Admin keys / centralized trust

The admin authority can:
- `pause` / `unpause` minting and trading globally.
- `admin_settle_override` to write a manual settlement price (subject to the 1-hour time delay).
- `add_strike` to inject intraday strikes that the morning job missed.

**This is centralized trust.** A compromised admin key could pause the protocol indefinitely or settle markets against users (after the 1-hour delay).

**Devnet admin pubkey:** `6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM` (held by the demo operator). The program upgrade authority is `7VDBVfpRi1MJWie8nwh9Xe8aWHdYZtMxBqZoKRMCexV9` — also a single key on devnet.

**Documented trade-offs and future improvements:**
- A production deployment should hold admin under a Squads multisig (3-of-5 or similar) with hardware-wallet signers.
- Program upgrade authority should likewise be a multisig, or removed entirely (immutable program) after a stabilization window.
- Governance over fee parameters could move on-chain via a SPL governance program in a v2.
- None of this is implemented in v1; v1 is single-key admin and is documented as such.

This is a deliberate trade-off vs the Drift BET multisig that was compromised in April 2026 for ~$285M. Drift's failure mode was *human-controlled settlement*; Meridian's autonomous oracle settlement avoids that specific failure mode while reintroducing a *different* centralization risk (admin override). The mitigation (1-hour delay + autonomous-first settlement) is in the program, but the underlying trust assumption is unchanged: if the admin key is stolen and the autonomous settle fails, the attacker can write a wrong outcome after 1 hour.

---

## 5. Stock market closure days

The PRD specifies a daily lifecycle (8:00 AM strike calc → 4:00 PM settle), but does not address NYSE holidays, half-days (1:00 PM ET close on the day after Thanksgiving and Christmas Eve), or unscheduled closures (rare circuit-breaker halts, weather closures, exchange outages).

**What's implemented:** the automation service consults an NYSE trading-day calendar in `automation/src/calendar.ts` and skips non-trading days. The morning job and the settle job both gate on this calendar.

**What's a known limitation:**
- The calendar must be kept up to date. If the next year's holiday schedule isn't added, automation will misbehave (create markets on Christmas, or fail to create them on a normal trading day if the calendar mis-flags it).
- Half-days are partially handled: the automation will still settle at 20:05 UTC (4:05 PM ET), but on a 1:00 PM ET close the Pyth feed will likely show a stale price at 4:05 PM. The on-chain staleness check will gate settlement and the admin override (after 1 hour) is the recovery.
- Unscheduled closures (e.g. a circuit-breaker halt mid-day) are *not* automatically handled. The admin must manually pause and decide whether to settle against the pre-halt last trade or to invoke override later.

A production version should subscribe to a real-time NYSE status feed (or a wrapped equivalent) instead of a static calendar.

---

## 6. Capital efficiency on the No side

The Buy-No flow is a **composite mint-and-sell**: user pays ~$1 USDC, the program mints 1 Yes + 1 No, then the program sells the Yes leg on the order book at the best bid. The user keeps 1 No token; net cost is `1 − yes_bid`.

The capital-efficiency note is that **during the composite tx**, the user is locking ~$1 of working capital per No they want to acquire — even though the net cost is much less (typically $0.30–$0.50 for a No at typical strike depths). The locked USDC is returned on the same transaction once the Yes sell fills, so the user does not *permanently* hold $1 of capital per No, but they need it briefly.

**Why this matters operationally:**
- A user with $100 USDC cannot buy 200 No tokens at $0.50 each in a single composite tx (which would naively only require $100 of net cost). They can only buy 100 — because the mint-pair leg requires $1 × 100 = $100 of working capital upfront.
- To buy more, they would need to chain multiple composite txs, with each cycle's proceeds funding the next.

**The Yes side has no equivalent constraint** — buying Yes is just `place_order(Bid)`, no mint-pair required.

**Documented in the UX** via the bet-preview panel (`BetPreview.tsx`) showing both "USDC needed to send" and "Net cost after Yes sell" for No-side orders, so users aren't surprised when an apparently cheap No order requires their full balance during execution.

This is not a bug — it's the cleanest way to express the Yes + No = $1 invariant atomically. A future optimization would integrate with a flash-loan provider so the Yes sale's proceeds fund the mint-pair leg in a single instruction.

---

## 7. 0DTE market lifecycle — no rollovers

Every Meridian market is **zero-days-to-expiration** (0DTE). Markets created in the morning expire at 4:00 PM ET that same day. After settlement, the market is dead — there is no rollover, no extension, no re-opening.

**Implication for users:** if you hold a Yes or No token across settlement, your only action is `redeem` (winners get $1, losers get $0). Unredeemed positions remain redeemable indefinitely, but they will not be traded further or marked-to-market.

**Implication for operators:** every trading day requires a fresh `morning` job that creates 40 new markets (or however many the dedup'd strike calculation produces). On a holiday or non-trading day, no markets are created and the prior day's markets simply stop trading at 4:00 PM ET.

**Not in scope for v1:** weekly expiries, monthly expiries, multi-strike calendars, American-style early exercise. See [IMPLEMENTATION_PLAN.md §11](IMPLEMENTATION_PLAN.md) for the explicit out-of-scope list.

---

## 8. Localnet vs devnet vs mainnet trade-offs

**Localnet (`make e2e-up`)** — `solana-test-validator` on `http://localhost:8899`. Full stack runs on one box. Useful for development, tests, and rapid iteration. The oracle is "real" only in the sense that the automation polls Pyth Hermes and writes to the program's `OracleAccount` — there is no Pyth Receiver on a localnet, so the chain of attestation is broken at the receiver layer.

**Devnet (optional)** — the same program + bootstrap scripts deploy to Solana devnet via Helius RPC (`anchor deploy` + `scripts/bootstrap-devnet.sh`) for a shareable public demo. Program ID `DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19`. **Like localnet, it uses Pyth Hermes → automation service → on-chain `OracleAccount`, not Pyth Receiver direct.** This is an architectural choice (§2 above): it keeps costs and operational complexity low, at the cost of a shorter attestation chain. The on-chain `settle_market` still enforces freshness and confidence checks, so a bad reading is still rejected. Devnet is not the default deployment (see the deployment guide).

**Mainnet (not deployed)** — would require Pyth Receiver integration (CPI to `update_price_feeds` on `PriceUpdateV2` accounts), a multisig admin, an audited program (currently OtterSec/Halborn-audit-pending in our hypothetical timeline), CFTC-or-equivalent legal review, geographic restrictions on the frontend, and a funded operator hot wallet for cron transactions. **Meridian is not deployed to mainnet.** Treat the codebase as devnet-grade.

---

## 9. Pyth equity feed coverage

The strike-calculation morning job and the `settle_market` instruction both depend on Pyth having a feed for each MAG7 ticker.

- AAPL, NVDA, TSLA are explicitly confirmed in Pyth's product announcements.
- MSFT, GOOGL, AMZN, META are implied as "mega-cap tech" but verify each feed exists on the target cluster before launch.
- Pyth's equity feeds run ~24/5; weekend coverage is by design narrower than crypto feeds.

Pyth feed-coverage drift is a permanent operational concern. If Pyth deprecates a feed mid-day, the affected markets will fail their staleness check at 4:00 PM ET and admin override is the only recourse.

---

## 10. Cluster / RPC dependencies

The frontend reads on-chain state via Helius RPC (`https://devnet.helius-rpc.com`). The automation service uses the same RPC. **Helius downtime would functionally stop the app**, even though the on-chain state is fine — the frontend can't fetch markets or order books, and the automation cron can't broadcast transactions.

Documented mitigation: configure a fallback public RPC (`https://api.devnet.solana.com`) — wired in `app/lib/connection.ts`. In production this should be a multi-RPC failover (Helius primary, QuickNode secondary, public RPC tertiary). Currently single-RPC on devnet.

---

## 11. Smart contract audit status

**Meridian's program is not audited.** Unit tests (32/32 passing) and integration tests exercise:
- Mint-pair / redeem-pair invariants (vault balance = $1 × pairs minted)
- Yes + No = $1 across the full price range
- Settlement at-or-above rule (`>=` strict, off-by-one tested at the strike boundary)
- Oracle staleness rejection, confidence-width rejection, valid path
- Admin override time-delay enforcement (rejects pre-delay, succeeds post-delay)

These tests catch known-shape bugs. They do not substitute for a third-party audit, which would be a prerequisite for any mainnet deployment.

---

## 12. What this project is *not*

To be explicit (this is the "intellectual honesty" §14.7 of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) asks for):

- **Not a regulated venue.** No CFTC FCM, no SEC ATS, no MSB. Not Apex Prediction Markets.
- **Not custodial.** The protocol holds USDC in per-market vaults; the operator does not custody user funds. Users self-custody Yes/No tokens.
- **Not audited.** Unit-test coverage is high but third-party audit is not done.
- **Not deployed to mainnet.** Devnet only.
- **Not gambling, lottery, or casino product.** This is a derivatives venue. Treat it as such.
- **Not a Polymarket competitor in any commercial sense.** The PRD spec is the product. Polymarket is mentioned in [IMPLEMENTATION_PLAN.md §13](IMPLEMENTATION_PLAN.md) only as a research reference.
- **Not financial advice.** Nothing in this repo or the live app constitutes financial, legal, or tax advice.

---

## 13. Bug reports and disclosure

Found a contract bug or invariant violation? File a GitHub issue marked `security` or contact the project author directly. There is no bug bounty for the devnet deployment because there are no real funds at stake; we will credit responsible disclosure in any future mainnet announcement.

---

*Last updated: 2026-05-24. See [IMPLEMENTATION_PLAN.md §8](IMPLEMENTATION_PLAN.md) for the source list of risks and [§14.7](IMPLEMENTATION_PLAN.md) for the framing on regulatory engagement.*
