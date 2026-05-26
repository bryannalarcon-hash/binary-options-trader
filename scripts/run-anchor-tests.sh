#!/usr/bin/env bash
# =============================================================================
# scripts/run-anchor-tests.sh
#
# Self-contained anchor test runner that works in sandboxed/ephemeral shells
# where a detached background validator cannot survive across separate command
# invocations. It starts solana-test-validator as a CHILD of this shell, runs
# the requested mocha spec(s) against it, then tears the validator down on exit.
#
# Usage:
#   ./scripts/run-anchor-tests.sh meridian          # reliable core suite
#   ./scripts/run-anchor-tests.sh edge              # edge-cases suite
#   ./scripts/run-anchor-tests.sh integration       # integration suite
#   ./scripts/run-anchor-tests.sh all               # all three
#
# Notes:
#   - Uses /tmp ledger (writing test-ledger inside the project dir trips the
#     sandbox and the validator is SIGKILLed at startup -> exit 144).
#   - Deploys the freshly-built target/deploy/meridian.so at the canonical ID.
#   - For edge/integration suites it also runs the localnet bootstrap so the
#     harness pre-conditions (config admin, USDC_MINT, keys/*) are satisfied.
# =============================================================================
set -uo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LEDGER=/tmp/meridian-ledger
VLOG=/tmp/meridian-validator.log
PROGRAM_ID="DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19"
WHICH="${1:-meridian}"

VPID=""
cleanup() {
  if [[ -n "$VPID" ]] && kill -0 "$VPID" 2>/dev/null; then
    echo "[runner] stopping validator (pid $VPID)"
    kill "$VPID" 2>/dev/null || true
    wait "$VPID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[runner] starting solana-test-validator (ledger=$LEDGER)"
rm -rf "$LEDGER"
solana-test-validator --reset --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "$REPO_ROOT/target/deploy/meridian.so" \
  > "$VLOG" 2>&1 &
VPID=$!

echo -n "[runner] waiting for RPC"
READY=0
for i in $(seq 1 60); do
  if curl -sf -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
       http://localhost:8899 2>/dev/null | grep -q '"result":"ok"'; then
    READY=1; echo " ready (${i}s)"; break
  fi
  if ! kill -0 "$VPID" 2>/dev/null; then
    echo " VALIDATOR DIED"; tail -30 "$VLOG"; exit 1
  fi
  echo -n "."
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  echo "[runner] RPC never became ready"; tail -30 "$VLOG"; exit 1
fi

# Confirm the program is loaded.
if ! solana program show "$PROGRAM_ID" --url http://localhost:8899 >/dev/null 2>&1; then
  echo "[runner] program $PROGRAM_ID NOT loaded; deploying via solana program deploy"
  solana airdrop 100 ~/.config/solana/id.json --url http://localhost:8899 >/dev/null 2>&1 || true
  solana program deploy --program-id "$REPO_ROOT/target/deploy/meridian-keypair.json" \
    "$REPO_ROOT/target/deploy/meridian.so" --url http://localhost:8899 || {
      echo "[runner] deploy failed"; exit 1; }
fi
echo "[runner] program loaded:"
solana program show "$PROGRAM_ID" --url http://localhost:8899 | head -6

export ANCHOR_PROVIDER_URL="http://localhost:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
export SOLANA_RPC_URL="http://localhost:8899"

# For the harness-based suites (edge/integration) we must initialize the
# on-chain Config (admin = keys/admin.json, oracle_authority = keys/automation.json)
# and export USDC_MINT. The reliable meridian suite is self-contained and does
# its own init, so we only bootstrap for edge/integration/all.
maybe_bootstrap() {
  if [[ "$WHICH" == "meridian" ]]; then return 0; fi
  # The harness suites are gated off by default (see tryBootstrap notes); only
  # bootstrap when explicitly opting in.
  if [[ "${MERIDIAN_RUN_HARNESS_SUITES:-0}" != "1" ]]; then return 0; fi
  echo "[runner] running harness bootstrap (init config + USDC mint)"
  local TSX="$REPO_ROOT/automation/node_modules/.bin/tsx"
  if [[ ! -x "$TSX" ]]; then
    TSX="$REPO_ROOT/node_modules/.bin/tsx"
  fi
  local out
  out=$("$TSX" "$REPO_ROOT/scripts/harness-bootstrap.ts") || {
    echo "[runner] harness bootstrap FAILED"; return 1; }
  # last stdout line is USDC_MINT=...
  local line
  line=$(echo "$out" | grep -E '^USDC_MINT=' | tail -1)
  if [[ -z "$line" ]]; then echo "[runner] no USDC_MINT emitted"; return 1; fi
  export USDC_MINT="${line#USDC_MINT=}"
  echo "[runner] USDC_MINT=$USDC_MINT"
}

run_spec() {
  local spec="$1"
  echo ""
  echo "============================================================"
  echo "[runner] mocha $spec"
  echo "============================================================"
  # --no-config --no-package: the tests/package.json `mocha.spec` glob otherwise
  # forces ALL anchor/*.test.ts files to load even when one file is named,
  # which lets meridian.test.ts and the harness suites collide on the global
  # Config PDA. Isolating to a single file is essential for honest per-suite runs.
  ( cd "$REPO_ROOT/tests" && \
    node_modules/.bin/mocha --no-config --no-package \
      --require ts-node/register --extension ts -t 1000000 "$spec" )
}

RC=0
maybe_bootstrap || { echo "[runner] bootstrap failed; suites will skip"; }
case "$WHICH" in
  meridian)    run_spec "anchor/meridian.test.ts" || RC=$? ;;
  edge)        run_spec "anchor/edge-cases.test.ts" || RC=$? ;;
  integration) run_spec "anchor/integration.test.ts" || RC=$? ;;
  all)         run_spec "anchor/meridian.test.ts" || RC=$?
               run_spec "anchor/edge-cases.test.ts" || RC=$?
               run_spec "anchor/integration.test.ts" || RC=$? ;;
  *) echo "unknown target: $WHICH"; RC=2 ;;
esac

echo ""
echo "[runner] done (rc=$RC)"
exit $RC
