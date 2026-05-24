#!/usr/bin/env bash
# =============================================================================
# scripts/dev-localnet.sh
# Bootstrap a local-validator dev environment for Meridian.
#
# What this does:
#   1. Ensures solana CLI is on PATH
#   2. Starts solana-test-validator in the background (if not already running)
#   3. Waits for the validator to be reachable
#   4. Airdrops 100 SOL each to dev, admin, automation wallets
#   5. Prints final balances
#
# Usage:
#   ./scripts/dev-localnet.sh                  # start + fund
#   ./scripts/dev-localnet.sh fund             # fund only (validator already running)
#   ./scripts/dev-localnet.sh stop             # kill the background validator
# =============================================================================

set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${REPO_ROOT}/.test-validator.pid"
LOG_FILE="${REPO_ROOT}/.test-validator.log"

DEV_PUBKEY=7VDBVfpRi1MJWie8nwh9Xe8aWHdYZtMxBqZoKRMCexV9
ADMIN_PUBKEY=6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM
AUTOMATION_PUBKEY=7ftxc24p61R3cJH212QAfNpoVLQfGLGU4oyMhzzG8Ufk
FEE_PUBKEY=VWqmqDBLxnTSYPJaiKFKAfUqt1tk4rrBXWb2RFjVrU8

CMD="${1:-start}"

stop_validator() {
  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping validator (pid $pid)..."
      kill "$pid" || true
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi
}

case "$CMD" in
  stop)
    stop_validator
    echo "Stopped."
    exit 0
    ;;

  fund)
    # validator must already be up; skip startup
    ;;

  start|"")
    # Start validator if not already running
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
      echo "Validator already running (pid $(cat $PID_FILE))."
    else
      echo "Starting solana-test-validator (logs: $LOG_FILE)..."
      cd "$REPO_ROOT"
      nohup solana-test-validator --reset --quiet > "$LOG_FILE" 2>&1 &
      echo $! > "$PID_FILE"
      echo "Started (pid $(cat $PID_FILE))."
    fi

    # Wait for RPC to be reachable
    echo -n "Waiting for RPC..."
    for i in $(seq 1 30); do
      if curl -sf -X POST -H 'Content-Type: application/json' \
           -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
           http://localhost:8899 > /dev/null 2>&1; then
        echo " ready."
        break
      fi
      echo -n "."
      sleep 1
    done
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Usage: $0 [start|fund|stop]"
    exit 1
    ;;
esac

# Airdrop to all wallets
echo ""
echo "Airdropping 100 SOL to each wallet..."
for pk in "$DEV_PUBKEY" "$ADMIN_PUBKEY" "$AUTOMATION_PUBKEY"; do
  solana airdrop 100 "$pk" --url http://localhost:8899 > /dev/null
done

echo ""
echo "=== Balances ==="
for label_pk in "Dev:$DEV_PUBKEY" "Admin:$ADMIN_PUBKEY" "Automation:$AUTOMATION_PUBKEY" "Fee:$FEE_PUBKEY"; do
  label="${label_pk%%:*}"
  pk="${label_pk#*:}"
  bal=$(solana balance "$pk" --url http://localhost:8899)
  printf "  %-12s %s   %s\n" "$label" "$pk" "$bal"
done

echo ""
echo "Local validator running at http://localhost:8899"
echo "Stop it with: $0 stop"
