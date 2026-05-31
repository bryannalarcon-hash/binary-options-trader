#!/usr/bin/env bash
# =============================================================================
# scripts/cron-pow-topup.sh
# Auto-top-up cron for Meridian devnet wallets.
#
# Run periodically (e.g., daily). Behavior:
#   1. Check admin + automation balances on devnet.
#   2. If either is below threshold, mine SOL into the dev wallet via
#      devnet-pow, then transfer to the underfunded wallets.
#   3. Idempotent: if both wallets already above threshold, exits in 1 second.
#
# Suggested cron entry (run at 2 AM local daily). Set HELIUS_DEVNET_RPC_URL for a
# faster keyed RPC (optional — falls back to public devnet):
#   0 2 * * * HELIUS_DEVNET_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY' /home/bryann/gauntlet/meridian/scripts/cron-pow-topup.sh >> /home/bryann/gauntlet/meridian/.cron-topup.log 2>&1
#
# Manual run: ./scripts/cron-pow-topup.sh   (or: HELIUS_DEVNET_RPC_URL=... ./scripts/cron-pow-topup.sh)
# =============================================================================

set -euo pipefail

# ----- Config -----
ADMIN_PK=6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM
AUTOMATION_PK=7ftxc24p61R3cJH212QAfNpoVLQfGLGU4oyMhzzG8Ufk
DEV_KEYPAIR="$HOME/.config/solana/id.json"

# Thresholds (SOL). Top up when balance dips below MIN. Top up to TARGET.
ADMIN_MIN=1.0
ADMIN_TARGET=3.0
AUTOMATION_MIN=1.0
AUTOMATION_TARGET=3.0

# Safety: cap how much we mine per run so a runaway script can't blow through SOL
MAX_MINE_SOL=10
DIFFICULTY=3
REWARD=0.02

# RPC — provide a keyed endpoint (faster) via the RPC or HELIUS_DEVNET_RPC_URL
# environment variable, e.g. export it in the crontab. NEVER hardcode an API key
# here. Falls back to the public devnet RPC when neither is set.
RPC=${RPC:-${HELIUS_DEVNET_RPC_URL:-https://api.devnet.solana.com}}
RPC_FALLBACK=https://api.devnet.solana.com

# ----- PATH setup (cron has minimal PATH) -----
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"

log() {
  echo "[$(date -Iseconds)] $*"
}

# Need bc for float comparison
if ! command -v bc >/dev/null 2>&1; then
  log "bc not installed; falling back to awk"
  flt_lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }
else
  flt_lt() { [ "$(echo "$1 < $2" | bc -l)" = "1" ]; }
fi

# Returns balance as a plain decimal (strips " SOL" suffix). Defaults to 0 on error.
get_balance() {
  local pk="$1"
  local out
  out=$(solana balance "$pk" --url "$RPC" 2>/dev/null) || out=$(solana balance "$pk" --url "$RPC_FALLBACK" 2>/dev/null) || out="0 SOL"
  echo "${out% SOL}"
}

log "=== Cron top-up started ==="
log "RPC: $RPC"

# ----- Check current balances -----
ADMIN_BAL=$(get_balance "$ADMIN_PK")
AUTOMATION_BAL=$(get_balance "$AUTOMATION_PK")
DEV_BAL=$(get_balance "$(solana-keygen pubkey "$DEV_KEYPAIR")")
DEV_PK=$(solana-keygen pubkey "$DEV_KEYPAIR")

log "Balances: dev=$DEV_BAL admin=$ADMIN_BAL automation=$AUTOMATION_BAL"

# ----- Compute what each wallet needs -----
need_admin=0
need_automation=0
if flt_lt "$ADMIN_BAL" "$ADMIN_MIN"; then
  need_admin=$(awk -v t="$ADMIN_TARGET" -v c="$ADMIN_BAL" 'BEGIN { printf "%.4f\n", t - c }')
fi
if flt_lt "$AUTOMATION_BAL" "$AUTOMATION_MIN"; then
  need_automation=$(awk -v t="$AUTOMATION_TARGET" -v c="$AUTOMATION_BAL" 'BEGIN { printf "%.4f\n", t - c }')
fi

total_needed=$(awk -v a="$need_admin" -v b="$need_automation" 'BEGIN { printf "%.4f\n", a + b }')
log "Need: admin=$need_admin automation=$need_automation total=$total_needed"

if [ "$(awk -v n="$total_needed" 'BEGIN { print (n > 0) }')" = "0" ]; then
  log "Both wallets above min; nothing to do."
  log "=== Done ==="
  exit 0
fi

# Mining is slow — cap to MAX_MINE_SOL per run
if flt_lt "$MAX_MINE_SOL" "$total_needed"; then
  log "Capping mine target at $MAX_MINE_SOL SOL (needed $total_needed)"
  total_needed=$MAX_MINE_SOL
fi

# ----- Mine if dev wallet doesn't already have enough -----
# Add a small overhead for tx fees
need_in_dev=$(awk -v n="$total_needed" 'BEGIN { printf "%.4f\n", n + 0.05 }')

if flt_lt "$DEV_BAL" "$need_in_dev"; then
  to_mine=$(awk -v n="$need_in_dev" -v c="$DEV_BAL" 'BEGIN { printf "%.4f\n", n - c }')
  # Convert SOL to lamports for devnet-pow -t flag
  target_lamports=$(awk -v sol="$DEV_BAL" -v extra="$to_mine" 'BEGIN { printf "%.0f", (sol + extra) * 1000000000 }')
  log "Mining ~$to_mine SOL into dev wallet (target $target_lamports lamports)"
  # Use public devnet for mining (more reliable than Helius for PoW claim txs)
  devnet-pow mine \
    -d "$DIFFICULTY" \
    --reward "$REWARD" \
    --no-infer \
    -t "$target_lamports" \
    -u "$RPC_FALLBACK" \
    -k "$DEV_KEYPAIR" 2>&1 | tee -a "${0%/*}/../.cron-topup-mine.log" || {
      log "Mining failed; will retry next run"
      exit 1
    }
  DEV_BAL=$(get_balance "$DEV_PK")
  log "Post-mine dev balance: $DEV_BAL"
fi

# ----- Transfer to admin if needed -----
if flt_lt "0" "$need_admin"; then
  log "Transferring $need_admin SOL to admin ($ADMIN_PK)"
  solana transfer "$ADMIN_PK" "$need_admin" \
    --from "$DEV_KEYPAIR" \
    --keypair "$DEV_KEYPAIR" \
    --url "$RPC" \
    --allow-unfunded-recipient \
    --fee-payer "$DEV_KEYPAIR" \
    --commitment confirmed 2>&1 | tail -3
fi

# ----- Transfer to automation if needed -----
if flt_lt "0" "$need_automation"; then
  log "Transferring $need_automation SOL to automation ($AUTOMATION_PK)"
  solana transfer "$AUTOMATION_PK" "$need_automation" \
    --from "$DEV_KEYPAIR" \
    --keypair "$DEV_KEYPAIR" \
    --url "$RPC" \
    --allow-unfunded-recipient \
    --fee-payer "$DEV_KEYPAIR" \
    --commitment confirmed 2>&1 | tail -3
fi

# ----- Final state -----
log "Final balances:"
log "  dev:        $(get_balance "$DEV_PK")"
log "  admin:      $(get_balance "$ADMIN_PK")"
log "  automation: $(get_balance "$AUTOMATION_PK")"
log "=== Done ==="
