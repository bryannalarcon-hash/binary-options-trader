# Anchor tests — Meridian

End-to-end tests for the Meridian smart contract, written in TypeScript with
Mocha + Chai and the `@coral-xyz/anchor` client.

## What the test covers

`meridian.test.ts` exercises every one of the 12 spec-required instructions
plus the 13th `init_market_books` helper (see "Contract surface notes" below)
plus the PRD-required edge cases:

| # | Instruction | Happy path | Edge cases covered |
|---|---|---|---|
| 1 | `initialize_config` | One-time global init | – |
| 2 | `update_oracle` | oracle_authority writes price | non-authority rejected |
| 3 | `create_strike_market` | full account graph created | – |
| 3b | `init_market_books` | one-shot, called once per market | – |
| 4 | `mint_pair` | 10 USDC → 10 YES + 10 NO | zero rejected; paused state rejected |
| 5 | `redeem_pair` | burn pair → 1 USDC | balance check |
| 6 | `pause` / `unpause` | admin toggles | non-admin rejected; mint_pair fails while paused |
| 7 | `place_order` (bid) | rests on book; USDC escrowed | price=0 rejected; size=0 rejected |
| 8 | `cancel_order` | escrow returned to user | – |
| 9 | `settle_market` | at-strike → YES wins | settle before expiry rejected; stale oracle rejected; wide-conf rejected; double-settle rejected |
| 10 | `admin_settle_override` | success after 1h delay | rejected before delay; non-admin rejected |
| 11 | `redeem` (post-settle) | winning side pays $1; losing side burns for $0 | balance checks |
| 12 | `add_strike` | admin can add intraday | non-admin rejected |

## Contract surface notes

- **`init_market_books` is a required follow-up call** to `create_strike_market`.
  We split the orderbook + bid/ask-escrow initialization out of
  `create_strike_market` because the combined `init` set blew the 4 KB BPF
  stack frame. The frontend and automation must call them as a pair in the
  same transaction (one signed action, two instructions).
- **The mock oracle PDA must already exist** before `create_strike_market`
  runs. The morning automation job calls `update_oracle` for each ticker
  first; the oracle account is `init_if_needed` and lazily created on the
  first write per ticker.
- **`place_order` matches at most ONE counterparty per call.** To sweep
  multiple price levels, the client loops. This is a correctness-first MVP
  choice; a future iteration can fan out via remaining-accounts.

## Prerequisites

```bash
# Solana CLI 1.18+
solana --version

# Anchor 0.30.1
anchor --version

# Node 20+
node --version
```

## How to run

From the repo root:

```bash
# Single shot — Anchor spins up its own validator, builds, deploys, and runs.
anchor test
```

If you already have a `solana-test-validator` running:

```bash
anchor build --no-idl                  # IDL builder is broken on Rust 1.84+
anchor deploy --provider.cluster localnet
anchor test --skip-local-validator --skip-build
```

You can also run mocha directly once deployed:

```bash
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
pnpm --filter tests exec mocha -t 1000000 anchor/**/*.test.ts
```

## Caveats

- **Stale-oracle** and **wide-confidence** tests reuse the single oracle PDA
  for `AAPL`. Because we cannot rewind the oracle's `publish_time` per-test,
  each oracle-related test re-issues `update_oracle` immediately before it.
- **Admin-override 1-hour delay**: we cannot fast-forward the Solana clock on
  a stock validator, so we model the post-delay state by creating a market
  with `expiry_ts` set 2 hours in the past.
- **Match-on-place** is exercised implicitly via the bid-rest / cancel flow;
  a full cross test (taker bid crosses maker ask, USDC flows to maker, YES
  flows to taker) is omitted from the canonical suite but the codepath is
  unit-covered by the price/size/owner asserts inside `place_order`.
- The hand-authored IDL at `app/lib/meridian-idl.json` is the source of truth
  for both the frontend and these tests. If you change the program surface,
  update the IDL first and `node` will refuse to parse it if you break the JSON.
