#!/usr/bin/env bash
# =============================================================================
# scripts/e2e-down.sh
# Tear down the full local stack: app, automation, validator.
# =============================================================================
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

kill_pidfile() {
  local label="$1"
  local pidfile="$2"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "    stopping $label (pid $pid)"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  else
    echo "    $label: no pid file"
  fi
}

echo "==> stopping app + automation + validator"
kill_pidfile "app" "$REPO_ROOT/.app.pid"
kill_pidfile "automation" "$REPO_ROOT/.automation.pid"

# Catch any straggler next-server / tsx processes spawned by pnpm --filter dev.
pkill -f "next-server" 2>/dev/null || true
pkill -f "tsx watch src/index.ts" 2>/dev/null || true

# Stop validator via dev-localnet helper.
./scripts/dev-localnet.sh stop || true

echo ""
echo "============================================================"
echo "  Meridian local stack is DOWN"
echo "============================================================"
