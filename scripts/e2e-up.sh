#!/usr/bin/env bash
# =============================================================================
# scripts/e2e-up.sh
# Bring up the full local stack:
#   1. solana-test-validator on :8899
#   2. Airdrop 100 SOL to dev/admin/automation
#   3. scripts/bootstrap-localnet.sh (deploy + USDC + config + markets)
#   4. automation service on :3001 (background)
#   5. Next.js app on :3000 (background)
#
# Idempotent. Logs in $REPO_ROOT/.{validator,bootstrap,automation,app}.log.
# =============================================================================
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BOOT_LOG="$REPO_ROOT/.bootstrap.log"
AUTO_LOG="$REPO_ROOT/.automation.log"
APP_LOG="$REPO_ROOT/.app.log"
AUTO_PID="$REPO_ROOT/.automation.pid"
APP_PID="$REPO_ROOT/.app.pid"

step() { echo ""; echo "==> $*"; }

step "[e2e-up 1/5] starting local validator (and funding wallets)"
./scripts/dev-localnet.sh start

step "[e2e-up 2/5] bootstrapping program + USDC + markets"
./scripts/bootstrap-localnet.sh 2>&1 | tee "$BOOT_LOG"

# -----------------------------------------------------------------------------
# Automation
# -----------------------------------------------------------------------------
step "[e2e-up 3/5] starting automation service (background, port 3001)"

if [[ -f "$AUTO_PID" ]] && kill -0 "$(cat "$AUTO_PID")" 2>/dev/null; then
  echo "    killing previous automation pid $(cat "$AUTO_PID")"
  kill "$(cat "$AUTO_PID")" || true
  sleep 1
fi
rm -f "$AUTO_PID"

nohup pnpm --filter automation dev > "$AUTO_LOG" 2>&1 &
echo $! > "$AUTO_PID"
echo "    automation pid=$(cat "$AUTO_PID")  logs=$AUTO_LOG"

# -----------------------------------------------------------------------------
# Frontend
# -----------------------------------------------------------------------------
step "[e2e-up 4/5] starting Next.js app (background, port 3000)"

if ss -lnt 2>/dev/null | grep -q ":3000 "; then
  echo "    app already listening on :3000 — leaving as-is"
else
  if [[ -f "$APP_PID" ]] && kill -0 "$(cat "$APP_PID")" 2>/dev/null; then
    kill "$(cat "$APP_PID")" || true
    sleep 1
  fi
  rm -f "$APP_PID"
  nohup pnpm --filter app dev > "$APP_LOG" 2>&1 &
  echo $! > "$APP_PID"
  echo "    app pid=$(cat "$APP_PID")  logs=$APP_LOG"
fi

# -----------------------------------------------------------------------------
# Wait for the app to bind :3000
# -----------------------------------------------------------------------------
step "[e2e-up 5/5] waiting for app on :3000"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:3000"; then
    echo "    app responding."
    break
  fi
  printf "."
  sleep 1
done
echo ""

echo ""
echo "============================================================"
echo "  Meridian local stack is UP"
echo "============================================================"
echo "  App        : http://localhost:3000"
echo "  Validator  : http://localhost:8899"
echo "  Automation : http://localhost:3001/health"
echo ""
echo "  Logs:"
echo "    Validator  : $REPO_ROOT/.test-validator.log"
echo "    Bootstrap  : $BOOT_LOG"
echo "    Automation : $AUTO_LOG"
echo "    App        : $APP_LOG"
echo ""
echo "  Bring it all down with: ./scripts/e2e-down.sh"
echo "============================================================"
