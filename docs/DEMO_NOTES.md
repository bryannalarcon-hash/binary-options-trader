# Meridian — Demo Notes

Last brought up: 2026-05-23. Stack left RUNNING after the bootstrap session.

## Live URLs

| Service     | URL                                  |
|-------------|--------------------------------------|
| Frontend    | http://localhost:3000                |
| Validator   | http://localhost:8899 (JSON-RPC)     |
| WebSocket   | ws://localhost:8900                  |
| Automation  | http://localhost:3001/health         |

## Bring it up / down

```bash
make e2e-up      # idempotent — validator, deploy, USDC, oracles, 40 markets, app, automation
make e2e-down    # stops app, automation, validator
```

Or run the underlying scripts directly:

```bash
./scripts/dev-localnet.sh start          # validator only
./scripts/bootstrap-localnet.sh          # deploy + USDC + oracles + markets (validator must be up)
./scripts/e2e-up.sh                      # the whole stack
./scripts/e2e-down.sh                    # stop the whole stack
```

## What's actually deployed on the localnet right now

| Thing            | Value                                                  |
|------------------|--------------------------------------------------------|
| Program ID       | `DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19`         |
| USDC mint        | written to `.env.local` (`USDC_MINT=...`)              |
| Config admin     | `keys/admin.json` → `6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM` |
| Oracle authority | same as admin                                          |
| MAG7 oracles     | populated via Pyth Hermes (fallback: hardcoded prices) |
| Markets          | 40 (6 per ticker except NVDA = 4 after dedup)          |
| Dev wallet USDC  | 100.00 USDC pre-minted                                 |

The exact USDC mint and per-bootstrap pubkeys are in `.env.local` after the
bootstrap runs.

## Phantom / browser-wallet setup

1. Install Phantom (or any Solana wallet) in your browser.
2. Switch network to **Localnet** / **Custom RPC** = `http://localhost:8899`.
3. Import the dev wallet so you have funded SOL + USDC:
   - Open Phantom → settings → import private key → paste the JSON byte array
     from `~/.config/solana/id.json` (Phantom accepts a Solana CLI-format
     keypair as long as you import the **secret-key bytes**, or you can use
     `solana-keygen recover` to derive the seed).
   - Pubkey: `7VDBVfpRi1MJWie8nwh9Xe8aWHdYZtMxBqZoKRMCexV9`
   - This wallet has 500M+ SOL and 100 USDC of the localnet mint.
4. Visit http://localhost:3000, click "Connect Wallet", choose Phantom,
   approve the connection.

If you'd rather not import that pubkey, you can:

- Connect any Phantom wallet, then `solana airdrop 10 <your-pubkey> --url http://localhost:8899`
- Use `spl-token transfer` to send some of the bootstrap USDC mint from
  `keys/admin.json` to your wallet.

## What's REAL on-chain vs SIMULATED

| Flow                                              | Status     | Notes |
|---------------------------------------------------|------------|-------|
| `initialize_config`                               | REAL       | Run once by bootstrap.ts |
| `update_oracle` (for all 7 MAG7 tickers)          | REAL       | Bootstrap + automation cron poke every 30s |
| `create_strike_market` + `init_market_books`      | REAL       | Bootstrap creates 40 markets; morning job also (bundled tx) |
| Frontend reading **markets list** from on-chain   | REAL       | `app/lib/markets-client.ts` → `program.account.market.all()` after mount; mock fallback if program missing |
| Frontend **USDC balance** from on-chain           | REAL       | `app/lib/usdc.ts` reads the dev wallet's USDC ATA |
| Frontend `mint_pair`                              | REAL       | `composite-tx.ts → buildAndSendMintPair` — builds Anchor tx, asks wallet to sign |
| Frontend `redeem` (post-settlement)               | REAL       | `composite-tx.ts → buildAndSendRedeem` |
| Frontend **trade flows** (Buy/Sell Yes/No)        | REAL       | `composite-tx.ts → buildAndSendTrade`. Dispatches per side (see "What's REAL on-chain" section below). |
| Close-and-reverse position constraint flow        | REAL       | `composite-tx.ts → buildCloseAndReverseTrade` bundles close + open. |
| Order book + recent-trades tape                   | REAL       | `markets-client.ts → useOrderBook` reads `program.account.orderBook.fetch` + subscribes via `onAccountChange`. `useRecentTrades` subscribes to `OrderMatched` via `onLogs`. |
| Portfolio positions list                          | REAL       | `positions-client.ts → useUserPositions` reads YES/NO SPL ATA balances per market. |
| History list                                      | REAL       | `positions-client.ts → useUserHistory` seeds from `getSignaturesForAddress(programId)` + parses program events, then subscribes via `onLogs`. |
| `cancel_order`                                    | REAL       | `cancel-order.ts → buildAndSendCancelOrder` — ready for the active-orders panel. |
| `settle_market` (automation)                      | REAL (cron)| Scheduled by `automation/src/jobs/settle.ts`; can be run ad-hoc via `pnpm --filter automation settle` |
| `admin_settle_override` / `pause` / `add_strike`  | REAL on contract | No UI surface yet |

## What's REAL on-chain (May 23 update)

All four CLOB trade flows + reads are now wired to the on-chain program.
Mock data is retained only as a graceful fallback when the program isn't
deployed or RPC calls hard-fail.

- [x] **Buy YES** — `place_order(Bid)` sweep on the YES book ask side via
      `sweepCrossableLevels` (up to 5 chained txs). Remainder rests as a bid.
- [x] **Sell YES** — `place_order(Ask)` sweep on the YES book bid side.
      Remainder rests as an ask.
- [x] **Buy NO** — composite: `mint_pair(qty)` (locks USDC, mints YES+NO),
      then `place_order(Ask @ 100-yesPrice)` sweep to sell the YES leg.
      User keeps NO tokens.
- [x] **Sell NO** — composite: `place_order(Bid @ 100-noPrice)` sweep to
      buy YES on the book, then `redeem_pair(qty)` burns YES+NO for USDC.
- [x] **Close-and-reverse** — `buildCloseAndReverseTrade` issues close
      (opposite-side place_order or composite) then open back-to-back.
- [x] **Order book reads** — `useOrderBook` fetches the zero-copy
      `OrderBook` PDA and subscribes via `connection.onAccountChange`,
      filtering empty slots (size=0 / owner=default) and sorting by price.
- [x] **Recent trades tape** — `useRecentTrades` subscribes via
      `connection.onLogs(programId)` and parses `OrderMatched` events with
      `EventParser`, filtered by market, capped at 50 entries.
- [x] **Portfolio positions** — `useUserPositions` reads YES + NO SPL
      `getAccount` balances across every known market. Entry price is
      approximated from current order-book midprice (the contract doesn't
      track per-trade cost basis on chain in v1).
- [x] **History** — `useUserHistory` seeds from
      `getSignaturesForAddress(programId, { limit: 50 })`, decodes each
      tx's `meta.logMessages` via `EventParser`, filters events where the
      caller's pubkey matches (taker / maker / user). Then subscribes
      live via `onLogs`.
- [x] **`cancel_order`** — `buildAndSendCancelOrder` builds the cancel
      ix with all escrow accounts. Refunds USDC (bid) or YES (ask).

### Sweep loop design

`place_order` matches at most ONE counterparty per call. To walk multiple
price levels the client uses `sweepCrossableLevels`:

1. Fetch the live OrderBook PDA.
2. `findBestCounterparty(ob, takerSide, limitCents)` returns the best
   crossable opposite-side maker (or null if no level crosses), excluding
   self via a self-trade pre-check.
3. Pass that maker's `counterparty_usdc` / `counterparty_yes` ATA into
   `place_order` (or the user's own ATAs as placeholders if nothing
   crosses → the order rests on the book).
4. After each tx, re-fetch the book and loop, capped at
   `MAX_SWEEP_ITERATIONS = 5`.
5. Any unfilled remainder is submitted in one final non-crossing tx so
   the leftover size rests on the book.

### Mock fallback behavior

When `env.programId` is unset, an RPC call throws, or the OrderBook PDA
doesn't exist yet (newer market not yet `init_market_books`'d), the hooks
fall back to deterministic mock data so the UI keeps rendering. This is
intentional dev UX preservation, NOT a silent simulation of the trade
flows themselves — trade-flow `simulate()` calls fire ONLY when the
program is missing entirely.

## Logs

| Service     | Path                                              |
|-------------|---------------------------------------------------|
| Validator   | `./.test-validator.log`                           |
| Bootstrap   | `./.bootstrap.log`                                |
| Automation  | `./.automation.log`                               |
| App         | `./.app.log`                                      |

PID files: `.test-validator.pid`, `.app.pid`, `.automation.pid`.

## Common operations

```bash
# Re-poke all 7 oracles by hand (auto-runs every 30s when automation is up)
pnpm --filter automation oracle-update

# Force the morning job (creates today's strikes if they don't exist yet)
pnpm --filter automation morning

# Force the settle job (will be no-op unless markets have hit expiry)
pnpm --filter automation settle

# Tail combined logs
tail -f .app.log .automation.log
```

## Known issues / quirks

1. **First-render markets data is mock.** The on-chain `program.account.market.all()`
   call happens in `useEffect` (client-side), so the SSR HTML always contains
   mock tickers + prices. The browser swaps in real on-chain markets within
   one polling tick (~10s). Cards may briefly show the same tickers but a
   different strike grid before settling.
2. **Anchor tests partially fail (9 pass / 21 fail / 23 pending).** The
   integration tests in `tests/anchor/meridian.test.ts` expect a *clean*
   validator (they want to `initialize_config` against their own freshly
   created USDC mint). Because `bootstrap.ts` already initialized config
   against the bootstrap mint, every test that hits a mint-pinned ix now
   fails with `ConstraintAddress`. Workaround: tear down (`make e2e-down`),
   restart the validator with `solana-test-validator --reset` (or
   `./scripts/dev-localnet.sh stop && start`), then run
   `pnpm --filter tests test:anchor` **before** bootstrap.
3. **Playwright e2e: 6/27 pass, 16 skipped (fixme), 5 fail.** The 5
   failures are content-text mismatches (the assertions look for copy
   strings the markup doesn't currently include — e.g. "Browse Markets",
   "Connect to view"). They don't indicate broken functionality, just
   drift between the spec strings and the rendered copy.
4. **Bigint native binding warning** in Next dev logs is harmless — pure JS
   fallback is used.
5. **WalletConnect / Reown** packages emit some critical-dependency warnings
   when compiled by Next 15. Harmless; the Solana wallet adapter still works.
6. **`solana-test-validator` is started with `--quiet`** so its log is sparse.
   For more verbose output edit `scripts/dev-localnet.sh` and drop `--quiet`.
7. **Time gate is bypassed.** `TEST_BYPASS_TIME_GATE=true` in `.env.local`
   tells the contract to skip the "must wait until expiry" check on
   `settle_market` for local dev. Remove this if you want to test the real
   gate.

## Test results snapshot

```
Anchor:    9 passing, 21 failing (clean-validator dependency), 23 pending
Playwright: 6 passed, 16 skipped (.fixme), 5 failed (copy mismatches)
```

## Recommended demo flow

1. Visit http://localhost:3000 — the landing page renders.
2. Click "Markets" — see all 7 MAG7 tickers with strike chains.
3. Click a card (e.g. NVDA $210) — see the trade page with order book.
4. Connect Phantom (with the dev wallet imported) — header shows
   "7VDB…CexV9" + the USDC balance (100.00).
5. Click "Buy Yes" / "Buy No" / "Sell Yes" / "Sell No" — toast confirms a
   REAL on-chain trade. Each tap signs a real Anchor `place_order` (or
   composite `mint_pair`/`redeem_pair` for the NO flows) and lands on the
   localnet. Explorer link in the toast resolves.
6. Portfolio page — shows REAL YES/NO holdings read straight from the
   user's SPL token accounts (no synthesis when the program is up).
7. (Optional, real on-chain) Run `pnpm --filter automation morning` to see
   bundled `create_strike_market` + `init_market_books` calls in
   `.automation.log`.
