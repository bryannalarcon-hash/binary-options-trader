# Meridian — Coding PRD (Parallel Swarm Edition)

**Source of truth:** `docs/IMPLEMENTATION_PLAN.md` — read it first; this document does not duplicate design decisions, it decomposes them into agent work units.

**Audience:** A swarm of AI coding agents operating in parallel. Each section below is a unit of work that can be claimed by exactly one agent, executed independently, and verified by a separate agent.

**Optimization target:** Maximize parallelism. Minimize inter-agent coordination overhead. Make every work unit self-contained behind a contract.

---

## 0. How to read this PRD

Every work unit (called a **task**) has the same structure:

```
T-<DOMAIN>-<NUM>  <one-line subject>
─────────────────
Owner agent type:  <e.g., coder, system-architect, tester>
Inputs:            <file paths, prior task outputs, env vars>
Outputs:           <files created/modified, exports, account schemas>
Depends on:        <list of task IDs that must complete first>
Parallel-safe with:<list of task IDs that can run simultaneously>
Verification:      <which verification subtask checks this; pass criteria>
Done when:         <objective completion criteria>
```

The **task IDs** form a directed acyclic graph. Tasks with no dependencies start at the root; tasks become claimable when all their `Depends on` tasks complete. The DAG is encoded in the Phase Tables (§5–§11). An orchestrator agent walks the DAG and dispatches work.

Tags carried over from `IMPLEMENTATION_PLAN.md`:
- **[MUST]** — fails the PRD if missing
- **[SHOULD]** — strongly recommended, ship if time permits
- **[MAY]** — pure enhancement

---

## 1. Swarm topology

```
                    ┌──────────────────────┐
                    │  Lead Orchestrator   │   ←─ you (human + main agent)
                    └──────────┬───────────┘
                               │ spawns + supervises
            ┌──────────────────┼──────────────────┐
            │                  │                  │
   ┌────────▼────────┐ ┌───────▼────────┐ ┌───────▼────────┐
   │  Architect      │ │  Implementer   │ │  Verification  │
   │  (planning,     │ │  Swarm         │ │  Swarm         │
   │  contracts,     │ │  (parallel     │ │  (continuous,  │
   │  arbitration)   │ │  per task)     │ │  non-blocking) │
   └─────────────────┘ └────────────────┘ └────────────────┘
            ▲                  │                  │
            │                  │ tasks            │ findings
            └──────────────────┴──────────────────┘
                            SendMessage
```

**Three swarm tiers, all addressable by name via SendMessage:**

1. **Architect (single agent, named `architect`)** — owns the task DAG, resolves contract ambiguities, arbitrates when two implementers disagree about a shared interface. Spawned at session start and kept alive throughout.

2. **Implementer Swarm (named per task, e.g., `coder-instr-mint-pair`)** — one agent per active task. Spawned by lead when dependencies clear. Reports completion via SendMessage to lead + relevant verifier.

3. **Verification Swarm (5 standing agents)** — continuously consume implementer outputs and report findings back. Standing roster:
   - `verifier-invariants` — checks math invariants (Yes+No=$1, vault balance, etc.)
   - `verifier-security` — checks signer/authority/account-ownership patterns
   - `verifier-prd-compliance` — cross-references each completion against IMPLEMENTATION_PLAN.md tags
   - `verifier-tests` — ensures every [MUST] feature has matching tests
   - `verifier-integration` — runs end-to-end lifecycle smoke tests in CI

**Spawning pattern (used by lead at the start of each phase):**

```javascript
// ONE message — all phase-N agents spawned in parallel, each knows whom to ping
Agent({ subagent_type: "coder", name: "coder-instr-mint-pair",
  prompt: "Implement T-SC-04 per CODING_PRD.md. When done, SendMessage to 'verifier-invariants' and 'verifier-tests'.",
  run_in_background: true })
Agent({ subagent_type: "coder", name: "coder-instr-settle-market",
  prompt: "Implement T-SC-06 per CODING_PRD.md. When done, SendMessage to 'verifier-security' and 'verifier-tests'.",
  run_in_background: true })
// ... (more parallel tasks)
```

After spawning, lead **stops** and waits for completion notifications. Lead never polls.

---

## 2. Agent roster (named roles)

| Agent name | Subagent type | Role | Lifecycle |
|---|---|---|---|
| `architect` | `system-architect` | Owns task DAG; arbitrates contract questions | Whole session |
| `verifier-invariants` | `reviewer` | Checks math invariants | Whole session |
| `verifier-security` | `security-auditor` | Checks signer/auth/ownership | Whole session |
| `verifier-prd-compliance` | `reviewer` | Cross-checks against IMPLEMENTATION_PLAN.md | Whole session |
| `verifier-tests` | `tester` | Ensures test coverage for [MUST] | Whole session |
| `verifier-integration` | `tester` | Runs full lifecycle on test validator | Phase 5+ |
| `coder-<task-id>` | `coder` | Implements one task | Per task; terminates when done |
| `tester-<task-id>` | `tester` | Authors tests for one task | Often paired with the coder |
| `docs-<task-id>` | `api-docs` | Writes docs for one task | Phase 6 |
| `frontend-<task-id>` | `coder` (frontend focus) | Implements one UI work unit | Per task |

Use these exact names — they are how agents address each other.

---

## 3. Communication protocol

**Format of every SendMessage between agents:**

```
TO: <recipient name>
SUMMARY: <one-line state change>
PAYLOAD:
  task_id: <T-XXX>
  status: <completed | blocked | needs_arbitration>
  outputs: <file paths + signatures>
  notes: <anything the recipient needs>
```

**Required handoff points:**
- Implementer → Verifier: on task completion, with output paths.
- Verifier → Implementer: when a check fails, with reproduction steps.
- Implementer → Architect: when a contract question arises (e.g., "T-FE-TR-05 expects an `OrderBookHandle` type but T-SC-02 exposes `Market<Phoenix>` — which is canonical?").
- Verifier → Lead: when a [MUST] feature regresses or is missing.
- Architect → Lead: when blocked on a decision only the human can make.

**Failure recovery:** if an implementer task fails (test red, build red, lint red), the verifier sends the failure summary back to that implementer's name. Implementer fixes and re-sends. Three rounds without resolution → escalate to architect.

---

## 4. Verification swarm — protocols

Verifiers run **continuously and non-blocking**. They never gate the next phase from starting; they file findings.

### 4.1 `verifier-invariants` — math contracts
Runs these checks on every smart-contract task completion:
- Property test: `for all p in [0, max]: yes_payout(p) + no_payout(p) == 1_000_000` (1 USDC in micro-units).
- Vault balance equality: `vault.amount == 1_000_000 * total_pairs_minted` after every mint/redeem/redeem_pair.
- Settlement comparison uses `>=`, not `>` (per PRD at-or-above rule).
- Fee account ≠ vault account.
- Settled outcome immutable: second call to `settle_market` reverts.

### 4.2 `verifier-security` — Solana-specific safety
- Every account constraint has correct ownership check (e.g., `mint.owner == spl_token::ID`).
- Every signer check actually enforces the right authority (admin vs user vs program PDA).
- PDA derivations use canonical seeds documented in IMPLEMENTATION_PLAN.md §4.1.
- No raw lamport math; use `**from.lamports.borrow_mut() -= x` only with checked arithmetic.
- Admin-only instructions all check `ctx.accounts.admin.key() == config.admin`.
- Admin settle override enforces `clock.unix_timestamp >= expiry + 3600`.
- Pause flag checked in `mint_pair`, `redeem_pair`, and any trade-touching instructions.

### 4.3 `verifier-prd-compliance` — feature coverage
Maintains a checklist mirroring `IMPLEMENTATION_PLAN.md §15 Features catalog`. On every implementer completion, marks the matching feature ID as done. Reports unmarked [MUST] items as red on every Lead status request.

### 4.4 `verifier-tests` — test coverage gate
For every [MUST] feature, require: at least one unit test, one integration test path, and one edge-case test (e.g., at-strike rounding, zero quantity, oracle stale).

### 4.5 `verifier-integration` — end-to-end smoke
Runs `make test-e2e` against `solana-test-validator` after every Phase 2/3/4/5 completion. The script:
1. `anchor build`
2. `anchor deploy` to localnet
3. Bootstrap markets via automation script
4. Run mint → trade → settle → redeem on a test wallet
5. Assert: USDC final balance correct, no orphan accounts, no failed txs

---

## 5. Phase 0 — Scaffolding (sequential, single agent)

**Goal:** Repo skeleton exists; all subsequent phases can clone files into it without conflict.

| Task | Subject | Owner | Outputs |
|---|---|---|---|
| T-S0-01 | Create monorepo with workspaces | `architect` then `coder-scaffold` | `package.json`, `Anchor.toml`, `Cargo.toml`, `tsconfig.json`, `pnpm-workspace.yaml`, directory tree: `programs/meridian/`, `app/`, `automation/`, `tests/`, `scripts/`, `docs/` |

**Phase 0 contract:** when complete, every Phase 1 task can find an existing parent directory for its files.

**Done when:** `pnpm install && anchor build && cd app && pnpm dev` all succeed (with empty stubs).

---

## 6. Phase 1 — Foundation modules (highly parallel, ~7 agents)

All tasks below run in parallel after Phase 0. None depend on each other.

| Task | Subject | Owner | Outputs | Verifier |
|---|---|---|---|---|
| T-S1-01 | Anchor program skeleton with empty instructions | `coder-anchor-skel` | `programs/meridian/src/lib.rs`, `programs/meridian/src/instructions/mod.rs` with stubs for all 9 instructions | `verifier-prd-compliance` |
| T-S1-02 | PDA derivation library | `coder-pdas` | `programs/meridian/src/pdas.rs` exporting `market_pda(ticker, strike, expiry) -> Pubkey`, `yes_mint_pda(market)`, `no_mint_pda(market)`, `vault_pda(market)` | `verifier-security` |
| T-S1-03 | Account schemas | `coder-accounts` | `programs/meridian/src/state/{config.rs, market.rs}` with `ConfigAccount`, `MarketAccount` structs matching IMPLEMENTATION_PLAN.md §4.1 | `verifier-invariants` |
| T-S1-04 | Pyth Receiver SDK wrapper | `coder-pyth` | `programs/meridian/src/pyth.rs` exporting `read_price(account, max_staleness, max_confidence_ratio, feed_id) -> Result<i64>` | `verifier-security` |
| T-S1-05 | Phoenix CPI client | `coder-phoenix` | `programs/meridian/src/phoenix.rs` exporting `create_market(ctx, yes_mint, usdc_mint) -> Pubkey`, `place_order_cpi(...)`, etc. | `verifier-security` |
| T-S1-06 | Frontend Next.js scaffold + wallet adapter | `frontend-scaffold` | `app/` Next.js app with `<WalletProvider>` wrapper, blank routes for all 5 pages, header with Connect button, basic Tailwind | `verifier-prd-compliance` |
| T-S1-07 | Automation service skeleton | `coder-automation-skel` | `automation/src/index.ts` with cron registration (node-cron), env loading, structured logger | `verifier-prd-compliance` |
| T-S1-08 | Shared TypeScript types package | `coder-types` | `packages/types/` with TS types mirroring on-chain account shapes (will be regenerated from Anchor IDL in Phase 2) | `architect` |

**Phase 1 contract:** every other module knows where to import shared types, PDAs, and account schemas from. No business logic yet — only contracts and stubs.

**Done when:** all 8 tasks report `completed` to lead; `verifier-prd-compliance` confirms no [MUST] features marked yet (correct — implementations come in Phase 2+).

**Parallelism note:** all 8 can run simultaneously. Different files, different agents, zero conflicts.

---

## 7. Phase 2 — Smart contract instructions (parallel, ~9 agents)

Every PRD-required instruction is its own task. Each task pair = coder + tester running together (the tester depends on the coder finishing first, then runs immediately).

| Task | Subject | Owner | Depends on | Outputs | Verifier |
|---|---|---|---|---|---|
| T-SC-01 | `initialize_config` | `coder-instr-init` | T-S1-01, T-S1-03 | `programs/meridian/src/instructions/initialize_config.rs` | invariants, security, prd-compliance |
| T-SC-02 | `create_strike_market` (includes Phoenix CPI to create book) | `coder-instr-create` | T-S1-01, T-S1-03, T-S1-05 | `instructions/create_strike_market.rs` | security, integration |
| T-SC-03 | `add_strike` (admin) | `coder-instr-add-strike` | T-SC-02 | `instructions/add_strike.rs` | security |
| T-SC-04 | `mint_pair` | `coder-instr-mint-pair` | T-S1-01, T-S1-03 | `instructions/mint_pair.rs` | invariants, security |
| T-SC-05 | `redeem_pair` (pre-settlement Yes+No → 1 USDC) | `coder-instr-redeem-pair` | T-SC-04 | `instructions/redeem_pair.rs` | invariants, security |
| T-SC-06 | `settle_market` (Pyth read + outcome write) | `coder-instr-settle` | T-S1-04, T-SC-02 | `instructions/settle_market.rs` | invariants, security, prd-compliance |
| T-SC-07 | `admin_settle_override` (1h delay enforced) | `coder-instr-override` | T-SC-06 | `instructions/admin_settle_override.rs` | security |
| T-SC-08 | `redeem` (post-settlement burn → USDC payout) | `coder-instr-redeem` | T-SC-06 | `instructions/redeem.rs` | invariants, security |
| T-SC-09 | `pause` / `unpause` | `coder-instr-pause` | T-SC-01 | `instructions/pause.rs` | security |

Each task has a **paired tester** task (`tester-<task-id>`) that:
- Reads the implementation when it completes
- Writes unit tests covering success path + every error path
- Marks the feature complete in `verifier-prd-compliance`'s checklist

**Parallelism within Phase 2:**
- T-SC-01, T-SC-02, T-SC-04 can start immediately after Phase 1 (no inter-deps).
- T-SC-03, T-SC-05, T-SC-06, T-SC-09 can start when their listed deps complete.
- T-SC-07, T-SC-08 start after T-SC-06.

A topological pass of the DAG yields ~3 waves of parallelism within Phase 2. Optimistic timeline: 9 tasks / 3 waves × ~30 min each ≈ 1.5 hrs wall-clock.

**Phase 2 contract:** all 9 instructions compile, are exported in `lib.rs`, and have green unit tests. Anchor IDL regenerates and Phase 1's `packages/types/` is updated from it.

**Done when:** `anchor build` succeeds, `anchor test --skip-deploy` passes all unit tests, `verifier-prd-compliance` marks F-SC-01 through F-SC-12 as covered.

---

## 8. Phase 3 — Frontend pages & components (parallel, ~12 agents)

All page/component tasks are mostly independent. They share `app/components/` and `app/lib/` — to avoid collision, each task **owns specific files**.

| Task | Subject | Owner | Depends on | Files owned |
|---|---|---|---|---|
| T-FE-01 | Landing page | `frontend-landing` | T-S1-06 | `app/app/page.tsx` |
| T-FE-02 | Markets page (grid, cards, countdown) | `frontend-markets` | T-S1-06 | `app/app/markets/page.tsx`, `app/components/MarketCard.tsx`, `app/components/SettlementCountdown.tsx` |
| T-FE-03 | Trade page layout + strike list | `frontend-trade-layout` | T-S1-06 | `app/app/trade/[ticker]/[strike]/page.tsx`, `app/components/StrikeList.tsx` |
| T-FE-04 | Order book display (both perspectives) | `frontend-orderbook` | T-S1-06, T-SC-02 (for Phoenix types) | `app/components/OrderBook.tsx`, `app/components/PerspectiveToggle.tsx` |
| T-FE-05 | Trade panel + 4 buttons + bet preview | `frontend-trade-panel` | T-SC-04, T-SC-05, T-SC-08 (for tx-build helpers) | `app/components/TradePanel.tsx`, `app/components/BetPreview.tsx` |
| T-FE-06 | Position-constraint modal + close+reverse bundled tx | `frontend-position-modal` | T-FE-05, T-SC-05 | `app/components/PositionConstraintModal.tsx`, `app/lib/composite-tx.ts` |
| T-FE-07 | Portfolio page (active + settled tabs) | `frontend-portfolio` | T-SC-08 | `app/app/portfolio/page.tsx`, `app/components/PositionRow.tsx`, `app/components/RedeemButton.tsx` |
| T-FE-08 | History page | `frontend-history` | T-S1-06 | `app/app/history/page.tsx` |
| T-FE-09 | Wallet connect modal | `frontend-wallet-modal` | T-S1-06 | `app/components/WalletConnectModal.tsx` |
| T-FE-10 | Settings panel (slide-over) | `frontend-settings` | T-S1-06 | `app/components/SettingsPanel.tsx` |
| T-FE-11 | Toast / notification system | `frontend-toasts` | T-S1-06 | `app/components/Toaster.tsx`, `app/lib/notify.ts` |
| T-FE-12 | Implied probability distribution chart (Breeden-Litzenberger) [SHOULD] | `frontend-implied-dist` | T-FE-03 | `app/components/ImpliedDistribution.tsx` |
| T-FE-13 | Calibration scorecard (Brier score) [SHOULD] | `frontend-calibration` | T-FE-07 | `app/components/CalibrationScorecard.tsx` |
| T-FE-14 | Market-maker dashboard view `/portfolio/mm` [SHOULD] | `frontend-mm-dashboard` | T-FE-07 | `app/app/portfolio/mm/page.tsx` |

**File ownership rule:** if a task needs to modify a file owned by another task, it must SendMessage that task's owner. No silent shared edits.

**Phase 3 contract:** every page renders without runtime error against a mock data layer (lib/mock-data.ts). Every interaction listed in IMPLEMENTATION_PLAN.md §16 fires the right callback even if it's stubbed.

**Done when:** `pnpm dev` serves all 5 pages, every button is wired (even if to a noop), `verifier-prd-compliance` marks F-FE-* features covered.

---

## 9. Phase 4 — Automation service (parallel, ~4 agents)

| Task | Subject | Owner | Depends on | Outputs |
|---|---|---|---|---|
| T-AS-01 | Morning job — read close, compute strikes, call create_strike_market | `coder-automation-morning` | T-SC-02 | `automation/src/jobs/morning.ts` |
| T-AS-02 | Settlement job — call settle_market with retry logic | `coder-automation-settle` | T-SC-06 | `automation/src/jobs/settle.ts` |
| T-AS-03 | NYSE trading-day calendar (hardcoded JSON for v1) | `coder-automation-calendar` | T-S1-07 | `automation/src/calendar.ts`, `automation/src/data/nyse-2026.json` |
| T-AS-04 | Mock-oracle module for localnet testing | `coder-mock-oracle` | T-S1-07 | `automation/src/mock-oracle.ts` |
| T-AS-05 | Health-check + alert webhook [SHOULD] | `coder-automation-alerts` | T-S1-07 | `automation/src/health.ts`, `automation/src/alerts.ts` |

**Phase 4 contract:** running `pnpm --filter automation start` against `solana-test-validator` with `USE_MOCK_ORACLE=true` produces correct create+settle behavior over a fast-forwarded clock.

**Done when:** `make test-automation` passes a simulated trading day in <30 seconds.

---

## 10. Phase 5 — Integration (sequential pairs, parallel tests)

Each integration test is its own task. Coders write the test; `verifier-integration` runs them in CI.

| Task | Subject | Owner | Depends on |
|---|---|---|---|
| T-IT-01 | Full lifecycle: create → mint → trade → settle → redeem (single user) | `tester-it-single-user` | All of Phase 2, 3, 4 |
| T-IT-02 | All 4 trade paths: Buy Yes, Buy No, Sell Yes, Sell No | `tester-it-trade-paths` | T-IT-01 |
| T-IT-03 | Multi-user scenario: MM mints+quotes, taker trades, both redeem | `tester-it-multi-user` | T-IT-01 |
| T-IT-04 | Oracle failure modes: stale, wide confidence, retry, admin override | `tester-it-oracle-fail` | T-SC-07 |
| T-IT-05 | Position constraint: bundled close+reverse tx atomicity | `tester-it-position-constraint` | T-FE-06 |
| T-IT-06 | Invariant property tests: Yes+No=$1 across 10K random prices | `tester-it-invariants` | T-SC-06 |
| T-IT-07 | Pause/unpause blocks trading | `tester-it-pause` | T-SC-09 |
| T-IT-08 | Frontend wallet flow: connect, sign, disconnect | `tester-it-fe-wallet` | T-FE-09 |
| T-IT-09 | Frontend order book real-time updates (both perspectives) | `tester-it-fe-orderbook` | T-FE-04 |
| T-IT-10 | Frontend portfolio P&L accuracy | `tester-it-fe-portfolio` | T-FE-07 |

**Phase 5 contract:** `make test-all` runs all integration tests against `solana-test-validator` and passes.

**Done when:** `verifier-integration` confirms green on the full lifecycle script.

---

## 11. Phase 6 — Polish, docs, demo (parallel, ~6 agents)

| Task | Subject | Owner | Depends on |
|---|---|---|---|
| T-D-01 | README with one-command setup (`make dev`) | `docs-readme` | All prior |
| T-D-02 | `docs/RISKS.md` per PRD §2.14 | `docs-risks` | All prior |
| T-D-03 | `docs/ARCHITECTURE.md` — system + sequence diagrams | `docs-architecture` | All prior |
| T-D-04 | `docs/FOR_OPTIONS_TRADERS.md` (Peak6 appeal §14.4) | `docs-options-traders` | All prior |
| T-D-05 | `docs/MARKET_MAKING.md` — capital-efficiency worked example | `docs-mm` | T-D-04 |
| T-D-06 | Demo script (5 min walkthrough) | `docs-demo` | All prior |
| T-D-07 | Devnet deployment + program ID published in README | `coder-deploy-devnet` | All prior, faucet-funded wallets |
| T-D-08 | Mainnet-beta bonus deploy with funded automation | `coder-deploy-mainnet` | T-D-07 |

**Phase 6 contract:** a fresh clone of the repo, with only `.env` filled in, runs `make dev` and produces a working app.

---

## 12. Per-task contract template (canonical example)

Below is the **full contract** for T-SC-04 (`mint_pair`). Every other task in §6–§11 follows this same shape; this one is fleshed out for reference.

```
─────────────────────────────────────────────────────────────
T-SC-04  Implement mint_pair instruction
─────────────────────────────────────────────────────────────
Owner agent type:   coder
Agent name:         coder-instr-mint-pair
Inputs:
  - programs/meridian/src/state/market.rs   (from T-S1-03)
  - programs/meridian/src/pdas.rs           (from T-S1-02)
  - programs/meridian/src/lib.rs stub       (from T-S1-01)
  - IMPLEMENTATION_PLAN.md §4.2 (instruction map), §15 F-SC-04
  - PRD project_1771969779565.pdf p.9 (Smart Contract Functions)

Outputs:
  - programs/meridian/src/instructions/mint_pair.rs (new file)
  - programs/meridian/src/instructions/mod.rs       (add re-export)
  - programs/meridian/src/lib.rs                    (add #[program] handler)

Function signature (CANONICAL — do not change):
  pub fn mint_pair(ctx: Context<MintPair>, amount_pairs: u64) -> Result<()>

Account context (CANONICAL):
  #[derive(Accounts)]
  pub struct MintPair<'info> {
      #[account(mut, has_one = vault)]
      pub market: Account<'info, MarketAccount>,
      #[account(mut, mint::authority = market)]
      pub yes_mint: Account<'info, Mint>,
      #[account(mut, mint::authority = market)]
      pub no_mint: Account<'info, Mint>,
      #[account(mut, token::mint = usdc_mint, token::authority = market)]
      pub vault: Account<'info, TokenAccount>,
      #[account(mut, token::mint = usdc_mint, token::authority = user)]
      pub user_usdc: Account<'info, TokenAccount>,
      #[account(mut, token::mint = yes_mint, token::authority = user)]
      pub user_yes: Account<'info, TokenAccount>,
      #[account(mut, token::mint = no_mint, token::authority = user)]
      pub user_no: Account<'info, TokenAccount>,
      pub usdc_mint: Account<'info, Mint>,
      pub user: Signer<'info>,
      pub token_program: Program<'info, Token>,
  }

Behavior (CANONICAL):
  1. require!(!config.paused, MeridianError::Paused)
  2. require!(!market.settled, MeridianError::AlreadySettled)
  3. require!(amount_pairs > 0, MeridianError::ZeroAmount)
  4. Compute usdc_amount = amount_pairs * 1_000_000  (USDC has 6 decimals)
  5. CPI: transfer usdc_amount from user_usdc to vault
  6. CPI: mint_to user_yes, amount_pairs (signed by market PDA)
  7. CPI: mint_to user_no, amount_pairs (signed by market PDA)
  8. market.total_pairs_minted = market.total_pairs_minted.checked_add(amount_pairs).unwrap()
  9. emit!(MintPairEvent { user, market, amount_pairs })

Errors to define in `errors.rs`:
  Paused, AlreadySettled, ZeroAmount, MathOverflow

Depends on:    T-S1-01, T-S1-02, T-S1-03
Parallel-safe with: T-SC-01, T-SC-02, T-SC-09
Verification:  verifier-invariants (vault math), verifier-security (signer + authority)
Tester:        tester-instr-mint-pair (paired) writes:
                 - Happy-path test: 5 pairs minted, balances correct
                 - Paused state rejects
                 - Settled market rejects
                 - Zero amount rejects
                 - Insufficient USDC reverts gracefully

Done when:
  - File compiles
  - `anchor test --skip-deploy -- --features mint_pair_only` passes
  - verifier-invariants confirms vault math
  - verifier-security confirms account constraints
  - verifier-prd-compliance marks F-SC-04 covered

Reports on completion:
  SendMessage TO: verifier-invariants, verifier-security, tester-instr-mint-pair
  WITH: { status: completed, outputs: [...file paths...], notes: "Ready for tests." }
```

**Every other task in this PRD has an equivalent contract.** They are abbreviated in the phase tables; the agent claiming a task should expand it to this shape using the inputs/outputs/depends-on entries plus the relevant IMPLEMENTATION_PLAN.md section as the source of truth.

---

## 13. File ownership map (collision prevention)

| Path | Owned by | Editable by others? |
|---|---|---|
| `programs/meridian/src/lib.rs` | `coder-anchor-skel` (T-S1-01); each instruction task adds its handler only | Yes, via append-only handler additions |
| `programs/meridian/src/instructions/<one>.rs` | Single owner per file | No |
| `programs/meridian/src/state/<one>.rs` | T-S1-03 | No (extensions only via separate files) |
| `programs/meridian/src/errors.rs` | Shared by every instruction task (append-only) | Append-only |
| `app/app/<route>/page.tsx` | One frontend task | No |
| `app/components/<one>.tsx` | One frontend task | No |
| `app/lib/composite-tx.ts` | T-FE-06 | No |
| `automation/src/jobs/<one>.ts` | One automation task | No |
| `tests/it-<name>.ts` | One tester task | No |
| `Anchor.toml`, `Cargo.toml`, `package.json` | Architect only | No — file PRs to architect |

**Rule:** if a task needs a shared file, it appends behind a marker comment and notifies `architect`.

---

## 14. Convergence checkpoints (gates)

After each phase, lead runs a **convergence check** before spawning the next phase's agents:

| Gate | Checks |
|---|---|
| **G0 → 1** | Phase 0 done; `pnpm install && anchor build && pnpm dev` succeeds |
| **G1 → 2** | Phase 1 stubs render; types exported; no [MUST] yet |
| **G2 → 3** | All 9 instructions compile + green unit tests; IDL regenerated |
| **G3 → 4** | All 5 pages render; all buttons wired (mock allowed) |
| **G4 → 5** | Automation runs full simulated trading day in <30s |
| **G5 → 6** | All integration tests green on solana-test-validator |
| **G6 → ship** | README dev-runs in fresh clone; devnet deploy succeeds; demo recorded |

Each gate is enforced by `verifier-integration` reporting green. Lead spawns the next phase only on green.

---

## 15. Failure recovery protocols

**When a task fails (build red, test red, lint red):**

1. The failing implementer agent receives the verifier's report.
2. Implementer attempts a fix and re-runs verification.
3. If fix succeeds → mark task complete, continue.
4. If 3 fix attempts fail → SendMessage to `architect` with: original task, error log, attempted fixes.
5. Architect either: (a) clarifies the contract and respawns the implementer, or (b) decomposes the task into smaller subtasks and spawns multiple implementers, or (c) escalates to Lead with a human-decision request.

**When a verifier flags a regression in already-complete work:**

1. Verifier sends the regression report to the original implementer's name + `architect`.
2. Architect determines whether the regression is caused by an upstream change.
3. If upstream: the upstream task is reopened (status flipped to in_progress); original task waits.
4. If isolated: original implementer re-spawned to fix.

**When two implementers produce conflicting contracts:**

1. Either implementer SendMessages `architect` immediately on detecting the conflict.
2. Architect arbitrates within 5 minutes: picks one contract, updates IMPLEMENTATION_PLAN.md if needed, notifies both implementers.
3. Loser-side implementer rewrites against the new contract.

---

## 16. Parallelism budget — wall-clock estimates

Assuming each implementer task averages 30–60 min of agent time:

| Phase | Tasks | Max parallel agents | Wall-clock (parallel) | Wall-clock (sequential, for comparison) |
|---|---|---|---|---|
| 0 | 1 | 1 | 30 min | 30 min |
| 1 | 8 | 8 | 60 min | 8 hr |
| 2 | 9 (3 waves) | 5 | 2.5 hr | 9 hr |
| 3 | 14 | 8 | 2 hr | 14 hr |
| 4 | 5 | 5 | 1 hr | 5 hr |
| 5 | 10 | 10 (read-only on shared state) | 1.5 hr | 10 hr |
| 6 | 8 | 6 | 1 hr | 8 hr |
| **Total** | **55** | **peak 10** | **~8.5 hr** | **~54 hr** |

**Speedup: ~6.5×** if the orchestrator + verifier swarm functions as designed.

---

## 17. Per-PRD-feature traceability table

Every [MUST] feature in IMPLEMENTATION_PLAN.md §15 maps to exactly one task ID here. `verifier-prd-compliance` maintains this matrix and reports gaps.

| Feature ID | Task ID(s) |
|---|---|
| F-SC-01 | T-SC-01 |
| F-SC-02 | T-SC-02 |
| F-SC-03 | T-SC-03 |
| F-SC-04 | T-SC-04 |
| F-SC-05 [SHOULD] | T-SC-05 |
| F-SC-06 | T-SC-06 |
| F-SC-07 | T-SC-07 |
| F-SC-08 | T-SC-08 |
| F-SC-09 | T-SC-09 |
| F-SC-10..F-SC-12 | (cross-cutting — verified across all SC tasks) |
| F-AS-01 | T-AS-01 |
| F-AS-02..03 | T-AS-02 |
| F-AS-04 | T-AS-05 |
| F-AS-05 | T-AS-03 |
| F-FE-LD-* | T-FE-01 |
| F-FE-MK-* | T-FE-02 |
| F-FE-TR-* | T-FE-03..T-FE-05, T-FE-12, T-FE-14 |
| F-FE-PO-* | T-FE-07, T-FE-13, T-FE-14 |
| F-FE-HI-* | T-FE-08 |
| F-FE-XC-* | T-FE-09..T-FE-11 |

---

## 18. Lead orchestrator's quickstart

```
1. Read IMPLEMENTATION_PLAN.md completely
2. Read this CODING_PRD.md completely
3. Spawn architect + 5 verifiers in ONE Agent message (background)
4. Run Phase 0 (single agent, foreground)
5. Spawn Phase 1's 8 agents in ONE message (background)
6. Wait for all 8 completion notifications
7. Run G1 convergence check
8. Spawn Phase 2 Wave 1 (T-SC-01, T-SC-02, T-SC-04) in ONE message (background)
9. ... [repeat for each wave + phase]
10. Final convergence: G6 green = ready to demo
```

When a verifier reports red, route the report to the named implementer and continue. Never block other agents on one slow task.

---

## 19. Out of scope for this PRD

- Code style guide and lint rules — handled by the scaffolding's eslint/prettier/clippy configs.
- Per-component CSS / theming — covered by Tailwind defaults + a small custom palette.
- Mobile-native apps — PWA via Next.js is sufficient (PRD §11).
- Multi-language i18n — English only for v1.

---

## 20. References

- `IMPLEMENTATION_PLAN.md` — design source of truth
- `WALLETS.md` — pubkeys + funding instructions
- `.env`, `.env.local`, `.env.example` — runtime config
- `scripts/dev-localnet.sh` — local validator bootstrap
- `project_1771969779565.pdf` — original PRD (Gauntlet)
