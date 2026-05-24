# Meridian — Tests

Two test suites live here:

| Suite | Path | Runner | What it covers |
|---|---|---|---|
| Anchor (Rust contract, TS driver) | `tests/anchor/` | Mocha + Chai + `@coral-xyz/anchor` | Per-instruction unit tests, full-lifecycle integration tests, edge cases / error paths |
| End-to-end (Playwright) | `tests/e2e/` | `@playwright/test` | The 70% most common user journeys through the Next.js app |

The two layers are independent — you can run either without the other.

---

## Quick start

```bash
# from the repo root
pnpm install                   # one-time; installs Playwright too
pnpm --filter tests typecheck  # static check both suites

# Anchor tests (needs a running solana-test-validator + deployed program)
make e2e-up                    # bootstraps the local stack
pnpm --filter tests test:anchor

# Playwright E2E (needs the stack from `make e2e-up`)
make e2e                       # alias for: pnpm --filter tests test:e2e

# Or let Playwright start the stack itself (CI-friendly):
pnpm --filter tests test:e2e:auto
```

If you have neither validator nor deploy, `test:anchor` will gracefully `skip()`
all on-chain tests with a clear log line — the static portions still execute,
and the suite returns 0 so CI stays green.

---

## Anchor suite layout

```
tests/anchor/
├── _setup.ts          # Shared fixtures: provider, PDAs, wallets, IDL loader
├── _assumptions.ts    # Documented contract assumptions + math reference
├── integration.test.ts
└── edge-cases.test.ts
```

`tests/anchor/meridian.test.ts` (if/when written by the smart-contract agent)
holds the per-instruction *unit* tests. This README covers the integration
and edge-case layers only.

### `integration.test.ts`

| Test ID | Scenario |
|---|---|
| T-IT-01 | Full lifecycle: `initialize_config` → `create_strike_market` → `mint_pair` → `place_order`/`match_orders` → `update_oracle` → `settle_market` → `redeem` |
| T-IT-02 | The 4 trade paths: Buy Yes, Buy No (composite mint+sell), Sell Yes, Sell No (composite buy+redeem-pair) |
| T-IT-03 | Multi-user: user A (MM) mints + quotes both sides; user B (taker) fills; both redeem after settlement |
| T-IT-05 | Position constraint: relaxed at the contract layer (transient pair-holding is allowed); the strict UI rule is exercised by Playwright test `08-position-constraint.spec.ts` |
| T-IT-06 | Invariant property test: fuzzes 1,000 random close prices and asserts `yes_payout + no_payout == 1_000_000` always; pins `price == strike → YES` |

### `edge-cases.test.ts`

| # | Scenario | Expected error |
|---|---|---|
| 1 | At-strike rounding (`price == strike → YES`) | (math) |
| 2 | Zero quantity (`mint_pair(0)`, `place_order(size=0)`) | `ZeroAmount` |
| 3 | Stale oracle (`publish_time` > 300s old) | `OraclesStale` |
| 4 | Wide-confidence oracle (`conf/|price| > 0.005`) | `OracleConfidenceWide` |
| 5 | Paused state blocks `mint_pair`, `place_order` | `Paused` |
| 6a | `admin_settle_override` before 1h delay | `TimeGateNotElapsed` |
| 6b | `admin_settle_override` after 1h delay | succeeds |
| 7 | Double-settle (`settle_market` called twice) | `AlreadySettled` |
| 8 | `redeem` before settlement | `NotSettled` |
| 9 | Redeem losing side → 0 USDC + tokens burned | (invariant — burn succeeds) |
| 10 | Order book full (17th order on same side) | `OrderBookFull` |
| 11 | `cancel_order` returns escrowed funds | (no revert; refund) |
| 12 | Non-admin calls admin instruction | `AdminRequired` / `ConstraintHasOne` |
| 13 | Non-oracle-authority calls `update_oracle` | `InvalidOracleAuthority` |

---

## E2E suite layout

```
tests/e2e/
├── playwright.config.ts            # Two modes: external (default) and auto-start
├── fixtures/
│   └── wallet.ts                   # Mock wallet adapter injected via addInitScript
└── tests/
    ├── 01-landing.spec.ts          # Landing renders, Connect Wallet visible, Browse Markets nav
    ├── 02-wallet-connect.spec.ts   # Modal opens/dismisses; mock-connect updates header
    ├── 03-markets-browse.spec.ts   # 7 MAG7 cards; click → /trade/[ticker]
    ├── 04-trade-buy-yes.spec.ts    # Buy Yes happy path + preview + toast
    ├── 05-trade-buy-no.spec.ts     # Buy No first-class; composite mint+sell; ONE signature
    ├── 06-trade-sell-yes.spec.ts   # Sell Yes from position; realized P&L
    ├── 07-trade-sell-no.spec.ts    # Sell No UX-abstracted; ONE signature
    ├── 08-position-constraint.spec.ts  # Holding No, Buy Yes → modal → bundled close+reverse
    ├── 09-settlement-redeem.spec.ts    # Settled market → Redeem button → USDC updates
    ├── 10-portfolio.spec.ts        # Tabs, columns, Redeem All
    └── 11-history.spec.ts          # Trade log + tx-sig explorer links
```

### Wallet mocking

Real wallets (Phantom, Solflare) require browser extensions Playwright cannot
drive in headless mode. Instead, `fixtures/wallet.ts` injects a mock adapter
into the page via `addInitScript`. The mock:

- Implements `window.solana` + `window.phantom.solana` with the
  Wallet-Standard surface used by `@solana/wallet-adapter-react`.
- Connects/disconnects synchronously and fires the events the React hook
  listens for.
- Records `signTransaction` calls so tests can assert "exactly one signature".

The deterministic test keypair is loaded from (in order):
1. `$E2E_USER_KEYPAIR_PATH`
2. `keys/e2e-user.json`
3. `keys/admin.json`
4. Deterministic in-memory seed (32 × `0x07`) — last resort

---

## Pass/skip matrix today

What you get when you run the suite against various states of the stack:

| Stack state | Anchor unit/integration | Anchor edge-cases | Playwright structural | Playwright behavioral |
|---|---|---|---|---|
| Nothing running | all skip (0 failures) | all skip | landing/markets/portfolio/history empty-state pass; rest skip | all `.fixme` |
| Validator only | all skip (no deploy) | all skip | same | same |
| Validator + `anchor deploy` | runs but each test skips (no IDL or stub handlers) | same | same | same |
| Validator + deploy + IDL + handlers wired | green | green | green | green |

All tests are written to compile + run today. As the contract handlers + UI
components land per the CODING_PRD task DAG, individual `.fixme()` and
`this.skip()` guards begin to activate the real assertions. No test file needs
to be touched again.

---

## Known fragilities

1. **Anchor IDL must be regenerated after every instruction signature change.**
   `anchor build` writes `target/idl/meridian.json`; we then copy/sync to
   `app/lib/meridian-idl.json`. If the IDL is stale, integration tests will
   pass the wrong account shape and fail with cryptic Anchor errors.
   *Mitigation:* `_setup.ts` prefers the freshly built `target/idl/...` over
   the committed copy.

2. **TEST_BYPASS_TIME_GATE.** Several edge-case tests need to settle a market
   whose expiry hasn't elapsed. The contract is expected to honor
   `TEST_BYPASS_TIME_GATE=1` (set in the test env) to short-circuit the
   `clock >= expiry_ts` guard. Tests without this bypass fall back to using
   already-past-expiry markets, but this requires re-creating the market each
   test (PDA collision tolerated).

3. **PDA collisions across runs.** `solana-test-validator --reset` is the
   recommended boot recipe for `make e2e-up`; if you skip `--reset` and re-run
   tests, market PDAs from the prior run will collide. Tests handle this by
   randomizing the expiry component and tolerating the
   `"already in use" / 0x0` error on `create_strike_market`.

4. **Wallet-adapter-react-ui modal selectors.** The library doesn't expose
   stable test IDs; we match on role/class names. If they upgrade the library
   and class names change, `02-wallet-connect.spec.ts` needs an update.

5. **Playwright auto-start mode** (`E2E_AUTOSTART=1`) shells out to
   `make e2e-up`, which itself takes ~30-60s to deploy the program on a
   fresh validator. Set `timeout: 5 * 60 * 1000` in the config; CI runners
   need at least 5 min for the first run.

6. **`@solana/spl-token` is needed for richer USDC-balance assertions.** Tests
   currently assert burn-succeeded as a proxy for "losing side payout = 0"
   (see edge-case #9); a stronger assertion would fetch the user's USDC ATA
   pre/post-redeem. The `spl-token` package is in our `devDependencies`;
   if the test agent has time, replace the proxy with a real ATA balance
   delta check.

7. **Mock wallet does NOT actually sign transactions on chain.** It records
   the `signTransaction` call but returns the unsigned tx. The behavioral
   E2E tests (the `.fixme` ones) require the app to use a signing path that
   tolerates this. The current best plan: when the app detects
   `window.__MERIDIAN_E2E__ === true`, it should route tx submission through
   a server-side helper that signs with the test keypair (kept in
   `keys/e2e-user.json`). That helper does not exist yet — track as an
   open item against the frontend agent.

---

## Files & ownership

| Path | Owned by | Status |
|---|---|---|
| `tests/anchor/_setup.ts` | tester agent (this PR) | new |
| `tests/anchor/_assumptions.ts` | tester agent (this PR) | new |
| `tests/anchor/integration.test.ts` | tester agent (this PR) | new |
| `tests/anchor/edge-cases.test.ts` | tester agent (this PR) | new |
| `tests/anchor/meridian.test.ts` | smart-contract agent (`coder-smart-contract`) | NOT this PR — unit tests live here |
| `tests/e2e/playwright.config.ts` | tester agent (this PR) | updated |
| `tests/e2e/fixtures/wallet.ts` | tester agent (this PR) | new |
| `tests/e2e/tests/*.spec.ts` | tester agent (this PR) | new |
| `tests/package.json` | tester agent (this PR) | updated |
| `tests/README.md` | tester agent (this PR) | new |

---

## Targeted runs

```bash
# Just the integration layer
pnpm --filter tests test:anchor:integration

# Just edge cases
pnpm --filter tests test:anchor:edge

# One Playwright file
pnpm --filter tests test:e2e -- 04-trade-buy-yes

# Headed (visible browser)
pnpm --filter tests test:e2e:headed

# Auto-start the full stack (CI)
pnpm --filter tests test:e2e:auto
```

---

## When a test fails

1. Look at the failure: does it ask for an instruction to exist in the IDL?
   → run `make build-program && cp target/idl/meridian.json app/lib/meridian-idl.json`.
2. Does it complain `Program not deployed`?
   → run `make e2e-up`.
3. Does it complain about `TimeGateNotElapsed`?
   → set `TEST_BYPASS_TIME_GATE=1` in `.env.local` and rebuild the contract
     so the gate respects the flag.
4. Playwright: artifacts (screenshot + trace + video) are in
   `tests/e2e/test-results/`. Open the `.zip` in
   `https://trace.playwright.dev`.

---

## References

- `docs/IMPLEMENTATION_PLAN.md` — design source of truth (§2.13 testing reqs,
  §16 per-page specs, §19 state machines, §20 error handling)
- `docs/CODING_PRD.md` — work breakdown (§10 Phase 5 integration tests, §4
  verification swarm protocols)
- `project_1771969779565.pdf` — original PRD (Gauntlet)
