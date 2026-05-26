# Meridian — AI Usage Log

> Required deliverable per the assignment ("AI Usage Documentation: Required").
> This documents *how* AI was used to build Meridian, what it produced, how its
> output was verified, and — importantly — where it was wrong and a human caught it.
> Last updated: 2026-05-25.

---

## 1. Tools used

| Tool | Role |
|---|---|
| **Claude Code (Anthropic), model Claude Opus 4.7** | Primary development agent — code authoring, refactoring, file edits, shell/CLI execution, deployment. |
| **Claude sub-agents (swarm orchestration)** | The main agent spawned specialized sub-agents (researcher / coder / tester / reviewer / analyst) for parallel work and independent verification. Configuration lives in `CLAUDE.md`. |
| **Solana / Anchor / Railway CLIs (driven by the agent)** | The agent ran `anchor build`, `solana program deploy`, `railway up`, `devnet-pow`, etc. directly. |
| **Pyth Hermes API** | Live market data source (a runtime dependency the AI wired up, not an AI tool). |

Human role: direction, requirement interpretation, approving risky/irreversible actions (deploys, key handling), and reviewing AI output for correctness. The human made the architectural calls when the AI surfaced trade-offs, and rejected several incorrect AI claims (see §5).

---

## 2. How AI was used, by phase

1. **Requirements distillation.** Claude read the assignment PRD and produced a structured requirement list (musts / shoulds / mays), then a distilled checklist. A verification sub-agent re-read the PRD independently to catch missed requirements.
2. **Competitive + stakeholder research.** Research sub-agents (with separate verification sub-agents) surveyed comparable products (Polymarket, Kalshi, Augur, Manifold, Solana-native venues) and researched Peak6 to shape product framing. Findings fed `docs/IMPLEMENTATION_PLAN.md §14`.
3. **Design & planning.** Claude authored `docs/IMPLEMENTATION_PLAN.md` (full feature/page/state-machine spec) and `docs/CODING_PRD.md` (a swarm-optimized task breakdown) — both treating PRD items as mandatory and layering recommendations on top.
4. **Smart contract.** Coder sub-agents implemented the Anchor program (`programs/meridian`, 16 instructions): in-contract CLOB, mint/redeem, oracle, settlement, parabolic fee. A reviewer sub-agent audited the $1 invariant and escrow segregation.
5. **Frontend.** Next.js 15 app (`app/`) built to the "caret" design system; real wallet → Anchor → `sendAndConfirm` transaction path.
6. **Automation.** Node + node-cron service (`automation/`) for daily market creation, settlement, and a ~30s Pyth Hermes → on-chain oracle refresh.
7. **Deployment.** Claude deployed the program to Solana devnet and both services to Railway, and diagnosed/fixed deploy-time failures (CVE scanner blocks, build-time env baking, program-extend/buffer-rent issues).
8. **Accuracy & honesty passes.** Claude removed inaccurate UI/doc claims (e.g. "Phoenix", "Pyth Pull Receiver", flat-fee) so documentation matches the as-built system, and de-mocked the frontend display layer so it reads real on-chain/oracle data instead of synthetic placeholders.
9. **Testing & docs.** Test suites (Anchor mocha + Playwright E2E) and the full `docs/` set were AI-authored.

---

## 3. Orchestration pattern

Work was decomposed into independent slices handled by named sub-agents, with the main agent acting as orchestrator/integrator. Two practices were used deliberately:

- **Parallel sub-agents** for independent work (e.g. auditing the contract, frontend, automation, and tests simultaneously), partitioned by directory to avoid edit conflicts.
- **Verification sub-agents** — a *separate* agent re-checked claims rather than trusting the producing agent's self-report. This caught real bugs (§5).

This is the SendMessage-coordinated, hierarchical pattern described in `CLAUDE.md`.

---

## 4. What AI produced (scale)

- Smart contract: 25 Rust files, 16 instructions.
- Frontend: ~70 TypeScript/TSX files.
- Automation: 19 TypeScript files.
- Tests: 29 test files (3 Anchor unit/edge/integration + 26 Playwright E2E).
- Documentation: this file plus 13 other docs in `docs/`.

All committed under a single AI-assisted history. The hand-authored Anchor IDL (`app/lib/meridian-idl.json`) was AI-maintained because the Anchor 0.30.1 IDL builder is broken on modern Rust.

### Measured AI usage (cost + tokens)

From Claude Code's `/usage` (approximate — local sessions on this machine only; excludes other devices/claude.ai):

| Metric | Value |
|---|---|
| Total cost | **$587.38** |
| API time | 10h 49m 57s |
| Wall time | ~2 days |
| Code changes | **28,181 lines added / 4,259 removed** |

| Model | Input | Output | Cache read | Cache write | Cost |
|---|---|---|---|---|---|
| `claude-opus-4-7` (primary dev) | 98.8k | 2.7m | 843.5m | 14.9m | $582.10 |
| `claude-haiku-4-5` (light tasks, 148 web searches) | 2.4m | 79.2k | 0 | 820.9k | $5.29 |

Reading: nearly all spend is Opus doing the development work; the heavy **cache-read** figure (843.5m tokens) reflects long agentic sessions re-reading a large, stable context (the repo + docs) across many turns. Haiku handled cheap, high-volume tasks (web searches, simple lookups) at ~1% of the cost.

---

## 5. Where AI was wrong, and how it was caught (honesty section)

AI output was **not** taken at face value. Notable corrections:

- **Incorrect "just re-push" claim.** After the `MockOracle → OracleAccount` rename, an agent claimed existing oracle PDAs would self-heal on redeploy. Inspecting the actual `update_oracle` account constraint showed this was false (the Anchor discriminator had changed, bricking the accounts). Fix: a new `close_oracle` instruction + re-stamping all 7 oracle PDAs.
- **`close_oracle` self-reverting bug.** A sub-agent's first `close_oracle` called `assign(&System::id())`, which silently undid the close. Caught in review and removed.
- **Stale oracle timestamp.** The oracle updater initially stamped Pyth's feed `publish_time` (the last-trade time, stale for equities after hours), which tripped the contract's 300s staleness gate and blocked settlement. Fixed to stamp write-time, with the rationale documented in code and `docs/RISKS.md`.
- **Mocked display data.** A late audit found the frontend's *display* layer (spot prices, strike chain, volumes, charts) was synthetic even though the transaction path was real — the mock AAPL spot ($220) didn't even match the real oracle ($309). This was corrected to read real on-chain data. (Documented here because it's a good example of AI "looking done" while a requirement — *real numbers* — was unmet.)
- **Inaccurate technology claims.** Early UI/docs referenced Phoenix and the Pyth Pull Receiver, which were never actually used (localnet/devnet lacked them). Removed so the docs are truthful about the as-built in-contract CLOB + custom oracle.
- **On-chain position guard — AI surfaced the trade-off, human made the call.** Asked to enforce the assignment's "users cannot hold both Yes and No for the same strike" rule on-chain (the PRD only required frontend enforcement), the AI did not just code it: it flagged that a literal "never hold both" rule conflicts with how NO is traded synthetically (mint pair + sell YES) and with the market-maker's minted inventory, and laid out the trade-offs. The **human chose the scope**: guard the order-book path only — allow the transient intra-transaction state, forbid the persistent one. The AI then implemented a new `assert_single_sided` instruction plus an instruction-introspection guard in `place_order` (a Bid acquiring YES while the buyer holds NO must be unwound by a trailing `assert_single_sided` in the same transaction), and rewrote the Sell-NO client flow into an atomic per-chunk `[buy YES + redeem_pair + assert]` transaction (`app/lib/composite-tx.ts`). Re-verified: Anchor suite 39/39, E2E spec 34 5/5.

The recurring lesson: AI is excellent at producing plausible, well-structured output quickly, but its self-reported "done" must be verified against the actual code, on-chain state, and the spec. Verification sub-agents + targeted human review were the control.

---

## 6. Reproducing the AI workflow

- AI config and agent routing: `CLAUDE.md` (project + global).
- Design intent: `docs/IMPLEMENTATION_PLAN.md`; task breakdown: `docs/CODING_PRD.md`.
- As-built truth + operating guide: `docs/HANDOFF.md`.
- Test results: `docs/TEST_RESULTS.md`.
- Deploy steps: `docs/DEPLOY_NOTES.md`.
