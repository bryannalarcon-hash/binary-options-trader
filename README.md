# Meridian

**Binary stock outcome markets on Solana.** Non-custodial. Pyth-powered. Settled at the close.

Meridian is an on-chain venue for binary cash-or-nothing options on MAG7 US equity daily closes. Each contract asks *"Will [STOCK] close at or above [STRIKE] today?"* and pays $1 USDC if Yes, $0 if No. Yes and No tokens sum to exactly $1.00 at all times — an invariant enforced on-chain by the program — which makes every market mathematically risk-free for a pair-holder and removes vol-surface modeling from the pricing problem. Markets are created automatically each morning at ±3/6/9% strikes around the previous close, traded intraday on an on-chain central limit order book, and settled at 4:00 PM ET against the Pyth Network's equity price feeds.

This is a technology demonstration deployed on Solana devnet (and fully runnable locally), with test USDC and no real funds. See [docs/RISKS.md](docs/RISKS.md) for the regulatory framing and known limitations.

---

## Status

| | |
|---|---|
| Live app | **deployed** — [meridian-app-production-f15c.up.railway.app](https://meridian-app-production-f15c.up.railway.app) (Solana devnet) |
| Run locally | one command — `make e2e-up` → http://localhost:3000 (full stack). See the [deployment guide](docs/DEPLOY_NOTES.md). |
| Cluster | Solana devnet (hosted app + on-chain market state); localnet for local dev |
| Program ID | `DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19` |
| Tests | anchor 39/39 + burner-driven Playwright (real on-chain) — full results in **[docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)** |
| AI usage | how this was built with AI — **[docs/AI_USAGE_LOG.md](docs/AI_USAGE_LOG.md)** |
| Smart contract instructions | 16 |
| Frontend pages | 5 of 5 |
| On-chain trade flows | 4 of 4 (Buy/Sell Yes, Buy/Sell No) |
| Position constraint | enforced **on-chain** (book path) + in UI — can't hold both Yes and No from trading |

---

## Try it now

**The app is live at [meridian-app-production-f15c.up.railway.app](https://meridian-app-production-f15c.up.railway.app)** (Solana devnet). Every action is a real on-chain transaction.

Public flow:
1. Install [Phantom](https://phantom.app) (or Solflare) and switch the network to **Devnet**.
2. Get test USDC: [spl-token-faucet.com](https://spl-token-faucet.com/?token-name=USDC-Dev), paste your wallet address, claim 100 USDC-Dev (mint `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`). Get a little devnet SOL for fees: `solana airdrop 1 <your-pubkey> --url devnet`.
3. Open the app, **Connect Wallet** → Phantom, approve.
4. Browse `/markets` — strike markets across all 7 MAG7 tickers (±3/6/9% around each stock's price). Click a card → trade page → **Buy Yes / Buy No / Sell Yes / Sell No**.
5. After settlement (4 PM ET), **Redeem** winning tokens for USDC on `/portfolio`.

**Prefer to run it yourself?** One command — **`make e2e-up`** → **http://localhost:3000** brings up the entire stack locally (validator + program + 40 markets + app `:3000` + automation `:3001`); seed liquidity with `pnpm mm:seed`. The built-in **Demo Wallet** + local faucet need no extension. See "One-command setup" below and the [deployment guide](docs/DEPLOY_NOTES.md).

Markets expire at **4:00 PM ET the same day** (0DTE). After settlement, Yes-side winners redeem at $1.00; losers redeem at $0.00. Unredeemed tokens stay redeemable indefinitely.

---

## Architecture

```
                                  +----------------------+
                                  |   Pyth Hermes API    |
                                  | (off-chain HTTP)     |
                                  +----------+-----------+
                                             |
                                             | poll every 30s
                                             v
+--------------------------+        +--------+----------+        +---------------------+
|  Frontend (Next.js 15)   |  RPC   | Automation (Node) |  CPI   |   Anchor program    |
|  React 19, Wallet Adapter|<------>| node-cron jobs    |------->|   16 instructions   |
|  Demo Wallet / Phantom   |        | morning + settle  |        |   on localnet       |
|  app/                    |        | automation/       |        |   programs/         |
+-----------+--------------+        +-------------------+        +----------+----------+
            |                                                                |
            |  signs tx via wallet adapter                                   |
            |  reads via @coral-xyz/anchor                                   |
            +----------------------------------------------------------------+
                                             |
                                             v
                                +-----------------------------+
                                | solana-test-validator :8899 |
                                |   Config PDA                |
                                |   40 Market PDAs            |
                                |   80 SPL mints (Yes + No)   |
                                |   40 USDC vaults            |
                                |   40 OrderBook PDAs         |
                                +-----------------------------+
```

The system has three runtime tiers:

- **Frontend (`app/`)** — Next.js 15.5 app with React 19, Solana Wallet Adapter, and a hand-built Anchor client (`app/lib/anchor-client.ts`). Five pages: Landing, Markets, Trade, Portfolio, History. All four trade flows wire to the on-chain program through `app/lib/composite-tx.ts`.
- **Anchor program (`programs/meridian/`)** — 16 instructions: `initialize_config`, `create_strike_market`, `init_market_books`, `add_strike`, `mint_pair`, `redeem_pair`, `place_order`, `cancel_order`, `assert_single_sided`, `settle_market`, `admin_settle_override`, `redeem`, `pause`, `set_risk_params`, `update_oracle`, `close_oracle`. 39/39 unit tests pass. Vault + pair invariants enforced on-chain; the **position constraint** (no holding both Yes and No on a strike from trading) is enforced on-chain on the order-book path via `assert_single_sided` + an introspection guard in `place_order`, not just in the UI.
- **Automation service (`automation/`)** — Node.js + `node-cron`, run locally as part of the stack (`:3001`). Two scheduled jobs (morning market creation; 4:05 PM ET settlement), gated by an NYSE trading-day calendar (`SKIP_CALENDAR_CHECK=true` to test off-hours). Pulls Pyth Hermes prices every ~30 seconds and pushes them into the on-chain OracleAccount that `settle_market` reads. Also serves the demo-wallet faucet.

For implementation depth, see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) (especially §3 architecture rationale, §4 contract design, §6 automation, §16 per-page UI specs).

### Why these choices

| Choice | Reason |
|---|---|
| Solana | Sub-second finality is required for a live order book; transaction fees ~$0.0003 keep micro-trades viable; Pyth's institutional MAG7 equity feeds run on Solana mainnet. |
| Rust + Anchor 0.30.1 | PRD-preferred; Anchor gives IDL generation, account-validation macros, and a typed TS client. |
| Custom on-chain CLOB | A custom in-contract CLOB (zero-copy `OrderBook` PDA, slot-based price levels) deploys cleanly to devnet without external dependencies; sweep loop in `composite-tx.ts` walks up to five price levels per market order. |
| Pyth Hermes → on-chain `update_oracle` (devnet) | The devnet demo uses Pyth Hermes (HTTP) polled by the automation service every 30 s and written to the program's `OracleAccount`, rather than Pyth Receiver pull-update CPI. This avoids per-update receiver costs and the devnet receiver setup. Trade-off documented in [docs/RISKS.md](docs/RISKS.md). |
| Yes + No = $1 invariant | Enforced by `mint_pair` / `redeem_pair` / `redeem` and vault-balance equality (`vault_USDC = $1 × total_pairs_minted`). Removes the need for a vol surface and gives market makers infinite capital efficiency in the pair-holding limit. |

---

## One-command setup

The Makefile is the entry point for both localnet development and devnet deployment.

### Localnet (full stack on one box)

```bash
make e2e-up      # idempotent — starts solana-test-validator, deploys the program,
                 # mints test USDC, initializes config, pokes oracles,
                 # creates 40 strike markets, starts the app on :3000,
                 # starts the automation cron on :3001
```

This brings up:

- `solana-test-validator` on `http://localhost:8899` / `ws://localhost:8900`
- Next.js dev server on `http://localhost:3000`
- Automation health endpoint on `http://localhost:3001/health`
- 40 strike markets across all 7 MAG7 tickers, expiring today at 4 PM ET

```bash
make e2e-down    # stops app, automation, validator
```

See [docs/DEMO_NOTES.md](docs/DEMO_NOTES.md) for the localnet demo walkthrough, including how to import the funded dev wallet into Phantom.

### Optional: deploy to Solana devnet

There is no single `make devnet-up` — the bootstrap sequence is intentionally two-step so program-deploy SOL costs are explicit:

```bash
# 1. Build the SBF binary (--no-idl works around an Anchor 0.30.1 / proc-macro2 incompatibility;
#    we ship a hand-written IDL at app/lib/meridian-idl.json).
anchor build --no-idl

# 2. Deploy the program (requires ~5 SOL of devnet SOL in the upgrade authority wallet).
anchor deploy --provider.cluster devnet

# 3. Bootstrap: initialize_config, register Pyth feed IDs for all 7 tickers,
#    create 40 strike markets at today's NY-close expiry, fund the automation wallet.
./scripts/bootstrap-devnet.sh
```

After the bootstrap completes, all addresses (program ID, admin pubkey, automation pubkey, fee destination, USDC mint, market PDAs) are written to `.env` at the repo root. This devnet path is optional — the supported deployment is the local stack above; see the [deployment guide](docs/DEPLOY_NOTES.md).

### Common operations

```bash
make install        # pnpm install everything
make build          # build program + app + automation
make test-anchor    # anchor mocha + rust unit tests (39/39 unit pass)
make e2e            # playwright e2e tests
make localnet       # validator only
make bootstrap      # one-shot localnet bootstrap (validator must be up)
make dev            # app + automation concurrently (validator must be up)
make clean          # nuke artifacts (target/, .next/, node_modules)
```

Useful service-level commands:

```bash
pnpm --filter automation morning        # force the morning job
pnpm --filter automation settle         # force the settle job (no-op pre-expiry)
pnpm --filter automation oracle-update  # re-poke all 7 oracles
pnpm --filter app dev                   # frontend only
```

---

## Project layout

```
meridian/
+- programs/meridian/         Anchor program — 16 instructions, 39 unit tests
+- app/                       Next.js 15 frontend (5 pages, wallet adapter, hand-written Anchor client)
|   +- app/                   App-router pages (/, /markets, /trade, /portfolio, /history)
|   +- components/            Header, MarketCard, OrderBookDisplay, TradePanel, ...
|   +- lib/                   Anchor client, composite-tx (real tx dispatch), markets/positions clients (real on-chain reads), trade-log, format helpers
+- automation/                Node.js cron service
|   +- src/jobs/              morning.ts, settle.ts, update-oracle.ts
|   +- src/calendar.ts        NYSE trading-day calendar
+- packages/types/            @meridian/types — shared TS types (workspace pkg)
+- scripts/                   bootstrap-localnet.sh, bootstrap-devnet.sh, e2e-up.sh, e2e-down.sh
+- tests/                     Anchor mocha + Playwright e2e
+- docs/                      IMPLEMENTATION_PLAN, RISKS, FOR_OPTIONS_TRADERS, MARKET_MAKING, DEMO_NOTES, DEPLOY_NOTES
+- Anchor.toml                Anchor workspace config
+- Makefile                   one-command entry points
+- pnpm-workspace.yaml        monorepo packages
```

---

## Tech stack

| Layer | Stack |
|---|---|
| Smart contract | Rust 1.84+, Anchor 0.30.1, anchor-spl 0.30.1, bytemuck 1.16 (zero-copy order book) |
| Cluster | localnet (`solana-test-validator`); optional devnet via Helius RPC; mainnet-ready |
| Frontend | Next.js 15.5.18, React 19 (RC), TypeScript 5.6, Tailwind 3.4, lucide-react |
| Wallet | `@solana/wallet-adapter-react` 0.15, Phantom + Solflare adapters |
| Solana client | `@coral-xyz/anchor` 0.30.1, `@solana/web3.js` 1.95, `@solana/spl-token` 0.4 |
| Automation | Node 20+, `node-cron` 3, `pino` 9 (structured logs), `dotenv` 16, `tsx` 4 |
| Oracle | Pyth Network — Hermes HTTP API for off-chain reads, custom `OracleAccount` for on-chain settlement |
| Tests | Mocha + chai (Anchor), Cargo unit tests (Rust), Playwright (e2e UI) |
| Deploy | local one-command stack (`make e2e-up`: `solana-test-validator` + Next.js + node-cron); optional devnet via `anchor deploy` |
| Package manager | pnpm 9.15.4 (workspace) |

---

## Settlement latency

Solana's structural advantage for this product is finality. Empirically:

- Devnet `place_order` average confirmation: **~600–900 ms** to `confirmed` (Helius RPC).
- Devnet `settle_market`: **~500–800 ms** for the on-chain instruction; entire automation cycle from market-close to redeemable is **under 60 seconds** (driven by the cron tick, not the chain).
- Polymarket settlement on UMA: **2 hours** dispute window (24 hours when challenged).
- Kalshi settlement: **manual, minutes** to hours depending on category.

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) §3 for the rationale (sub-second finality as a design constraint) and §14.4 for the Peak6-appeal framing of this benchmark.

---

## Documentation

| Doc | Audience |
|---|---|
| **[docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)** | **Test deliverable** — anchor 39/39 (incl. the on-chain position-guard suite), burner-driven E2E inventory, reproduce-it commands. |
| **[docs/AI_USAGE_LOG.md](docs/AI_USAGE_LOG.md)** | **AI Usage deliverable** — how AI built this, what it produced, where it was wrong, and measured cost/token usage. |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | The full PRD-mapped build plan — 1100 lines, every architectural decision justified. |
| [docs/RISKS.md](docs/RISKS.md) | Regulatory framing, oracle dependency, admin trust, capital-efficiency notes. PRD §2.14 deliverable. |
| [docs/FOR_OPTIONS_TRADERS.md](docs/FOR_OPTIONS_TRADERS.md) | Meridian in derivatives language: binary cash-or-nothing options, Greeks for digitals, Breeden–Litzenberger implied distribution, delta hedging. |
| [docs/MARKET_MAKING.md](docs/MARKET_MAKING.md) | Worked MM example, capital requirement, SDK pointer, delta-hedge venues. |
| [docs/DEMO_NOTES.md](docs/DEMO_NOTES.md) | Localnet demo walkthrough — what's real vs simulated, recommended demo flow. |
| [docs/DEPLOY_NOTES.md](docs/DEPLOY_NOTES.md) | **Deployment guide (local)** — the one command, localnet constraints, local architecture, reset procedure. |

---

## Acknowledgments

- **Pyth Network** — the institutional-grade price feeds that make on-chain equity settlement credible. Pyth's publisher set (Jane Street, Jump Trading, Two Sigma, Virtu, Cboe, Peak6 Capital Management) is the regulatory-credible backstop.
- **Solana Labs** — sub-second finality, low fees, and an SPL token program that makes the Yes/No mint model trivial.
- **Anchor / Coral** — the framework that makes Solana program development bearable.

---

## License

MIT. See [LICENSE](LICENSE) if present in the repo; otherwise, the standard MIT terms apply. No warranty. Not financial advice. Not an offer to US persons. See [docs/RISKS.md](docs/RISKS.md).
