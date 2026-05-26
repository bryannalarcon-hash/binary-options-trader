# Meridian — Deployment Guide (Local)

Meridian's supported deployment is a **self-contained local stack**: a
`solana-test-validator`, the deployed program, the bootstrapped markets, the
Next.js web app, and the automation cron — all on one machine, brought up with
**one command**. This is the environment the demo, the tests, and the full
create → mint → trade → settle → redeem lifecycle run in.

> Why local? The app uses no real funds and no mainnet (a hard requirement).
> Running everything on a local validator makes the full lifecycle reproducible
> offline, with deterministic state you can reset at will — no faucet rationing,
> no devnet RPC throttling, no hosting cost. The program is also deployable to
> Solana devnet (the same `anchor deploy` + bootstrap scripts), but that is an
> optional path, not the deployment this guide describes.

---

## One command

```bash
make e2e-up
```

(The same one-command entry point is documented in the project [README](../README.md).)

Tear it down with:

```bash
make e2e-down
```

`make e2e-up` is **idempotent** and performs, in order:

1. start `solana-test-validator` (RPC `:8899`, WS `:8900`) — with `--reset` only
   when no validator is already running;
2. deploy the program (`target/deploy/meridian.so`) at the fixed program ID;
3. bootstrap: initialize Config, create the play-money USDC mint, stamp the 7
   oracles from real Pyth Hermes prices, create 40 strike markets (expiry = today
   4 PM ET);
4. start the automation cron + faucet (`:3001`);
5. start the Next.js app (`:3000`).

Then seed a two-sided book on every strike so the order book isn't empty:

```bash
pnpm mm:seed     # posts a resting bid + ask (size 100) on all 40 strikes
```

**Deployment link (local):** http://localhost:3000
(automation health: http://localhost:3001/health)

---

## Architecture of the local deployment

```
                         Pyth Hermes API (HTTPS, off-chain)
                                    │  poll ~30s
                                    ▼
  Next.js app  ──RPC──►  Automation (node-cron)  ──tx──►  solana-test-validator
  :3000                  :3001  morning + settle           :8899 / ws :8900
   │  signs via               + faucet + oracle             │
   │  wallet adapter            refresh                     ▼
   │  reads via @coral-xyz/anchor                  Meridian program (16 ix)
   └────────────────────────────────────────────►  Config PDA · 40 Market PDAs
                                                     80 Yes/No mints · 40 vaults
                                                     40 OrderBook PDAs · 7 oracles
```

- **Validator** — local Solana cluster; all on-chain state (Config, markets,
  mints, vaults, books, oracles) lives here and is wiped on a `--reset`.
- **Program** — the 16-instruction Anchor program (in-contract CLOB, mint/redeem,
  oracle settlement, parabolic fee, on-chain position guard). Built with
  `anchor build --no-idl`; the hand-authored IDL is `app/lib/meridian-idl.json`.
- **Automation (`:3001`)** — node-cron jobs (morning market creation, 4:05 PM ET
  settlement), a ~30s Pyth Hermes → on-chain `update_oracle` refresh, and a
  **faucet** endpoint that airdrops SOL + mints play-money USDC to demo wallets.
- **App (`:3000`)** — Next.js 15 frontend; connect via the built-in **Demo
  Wallet** burner (no extension) or Phantom/Solflare pointed at a custom RPC of
  `http://localhost:8899`.

---

## Constraints of the local deployment (read these)

- **Ephemeral state.** A fresh `--reset` validator wipes everything. The bootstrap
  recreates Config, markets, and oracles each time. Use a stable USDC mint keypair
  (`keys/usdc-mint.json`) so the mint address survives resets within a machine.
- **Play money only.** USDC here is a local mint controlled by our admin authority
  — it has no value. The faucet (`automation/src/faucet.ts`) is **hard-refused on
  mainnet** and the burner "Demo Wallet" keys are localnet/devnet play keys, never
  real-funds keys.
- **Time gates are bypassed for the demo.** `.env.local` sets
  `TEST_BYPASS_TIME_GATE=true` and `SKIP_CALENDAR_CHECK=true`, so create / trade /
  settle / redeem all work any time — including weekends and after hours — without
  an internet connection (only the optional Pyth refresh needs the network).
- **Oracle freshness semantics.** The automation stamps each oracle's
  `publish_time` to write-time (not Pyth's last-trade time, which is stale for
  equities after hours). The contract's 300s staleness gate therefore validates
  that *the price pipeline is alive*, while the price *value* is the genuine latest
  Pyth Hermes price. (Rationale also in `docs/RISKS.md`.)
- **The validator must stay alive.** It is a child process of the shell that
  launched it; on WSL it can be killed by a process-group signal. Symptoms:
  `ERR_CONNECTION_REFUSED`, balances read 0, trades fail. Recovery: re-run
  `make e2e-up`, then restart the app so it re-reads env.
- **Restart the app after re-bootstrapping.** `NEXT_PUBLIC_*` env (e.g. the USDC
  mint) is inlined when `next dev` starts. If you re-bootstrap (new mint) without
  restarting the app, the served bundle carries a stale mint and USDC reads $0.
- **Empty-book vs seeded.** A fresh `make e2e-up` leaves books empty (market orders
  can't fill — by design). Run `pnpm mm:seed` for a liquid demo. The empty-book
  test specs require the *unseeded* state.

---

## Reset to a known state

Settlement is permanent on-chain, so re-running the settle/redeem flows needs a
genuinely fresh ledger. `make e2e-up` alone **reuses a running validator** (it
only passes `--reset` when none is live), so prior state persists. The reliable
reset is:

```bash
make e2e-down          # stop app + automation + validator
make e2e-up            # fresh validator → deploy → bootstrap → app + automation
pnpm mm:seed           # re-seed liquidity
```

---

## Operating the local stack

```bash
pnpm --filter automation morning        # force the morning market-creation job
pnpm --filter automation settle         # force the settle job (no-op pre-expiry)
pnpm --filter automation oracle-update  # re-poke all 7 oracles from Hermes
```

Read-only diagnostics (in `tests/e2e/scripts/`): `dump-books.ts` (live book
state), `list-markets.ts`, `who-holds.ts`.

The **Admin (demo)** wallet in the connect modal loads the config-admin key so an
operator can push oracle prices / settle / create markets / pause from the
browser. The key is served by `/api/admin-key`, which is **hard-gated to localnet**
(it refuses unless the RPC is localhost and never bundles the key client-side).

---

## On-chain identifiers (local)

| Item | Value |
|------|-------|
| Program ID | `DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19` |
| Admin / oracle authority | `keys/admin.json` (also the play-money USDC mint authority) |
| Automation signer | `keys/automation.json` |
| Fee destination | `keys/fee_destination.json` (USDC ATA auto-created at bootstrap) |
| USDC mint (local) | persisted at `keys/usdc-mint.json`; address written to `.env.local` at bootstrap |
| Markets | 40 strike markets across the 7 MAG7 tickers, expiry = today 4 PM ET |

All addresses are written to the repo-root `.env.local` after bootstrap. Secrets
live under `keys/` and are gitignored; never commit them.

---

## Optional: deploying to Solana devnet

The same program and scripts deploy to devnet (`anchor deploy --provider.cluster
devnet` + `scripts/bootstrap-devnet.sh`), which is useful for a shareable public
demo. It is **not** the deployment this guide covers and is not required to run
Meridian: it needs a funded upgrade-authority wallet (~4–5 SOL for the program
buffer) and a re-bootstrap whenever the on-chain account layout changes. Use the
local stack above for development, testing, and the lifecycle demo.
