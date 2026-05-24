#!/usr/bin/env bash
# =============================================================================
# scripts/bootstrap-localnet.sh
#
# Assumes solana-test-validator is already running on http://localhost:8899
# (see scripts/dev-localnet.sh). This script:
#
#   1. Sanity-check validator + CLI config.
#   2. Deploy programs/meridian to the validator (idempotent — `solana program
#      deploy` updates the existing program if the keypair is the same).
#   3. Mint a fresh SPL token to use as devnet "USDC" (6 decimals), persist the
#      mint to .env.local, and pre-fund the admin wallet with 1,000,000 USDC.
#   4. Hand off to scripts/bootstrap.ts which:
#        - initialize_config
#        - update_oracle for each MAG7 ticker
#        - create_strike_market + init_market_books for each ±3/6/9% strike
#        - mint 100 USDC to the dev wallet
#
# Idempotent. Safe to re-run; existing accounts are skipped.
# =============================================================================
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RPC=http://localhost:8899
ENV_LOCAL="$REPO_ROOT/.env.local"
ADMIN_KEY="$REPO_ROOT/keys/admin.json"
PROGRAM_KEYPAIR="$REPO_ROOT/target/deploy/meridian-keypair.json"
PROGRAM_SO="$REPO_ROOT/target/deploy/meridian.so"

echo "[bootstrap-localnet] step 1/4 — sanity checks"

if ! curl -sf -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" > /dev/null 2>&1; then
  echo "ERROR: solana-test-validator not reachable at $RPC" >&2
  echo "Start it with: ./scripts/dev-localnet.sh start" >&2
  exit 1
fi

if [[ ! -f "$PROGRAM_SO" ]]; then
  echo "ERROR: program binary not found at $PROGRAM_SO" >&2
  echo "Run: make build-program" >&2
  exit 1
fi

if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "ERROR: program keypair not found at $PROGRAM_KEYPAIR" >&2
  exit 1
fi

# Make sure the CLI is pointed at localnet + the dev wallet.
solana config set --url "$RPC" --keypair "$HOME/.config/solana/id.json" > /dev/null

DEV_PUBKEY=$(solana address)
ADMIN_PUBKEY=$(solana address --keypair "$ADMIN_KEY")
PROGRAM_ID=$(solana address --keypair "$PROGRAM_KEYPAIR")

echo "    RPC:        $RPC"
echo "    Dev wallet: $DEV_PUBKEY  ($(solana balance))"
echo "    Admin:      $ADMIN_PUBKEY  ($(solana balance "$ADMIN_PUBKEY"))"
echo "    Program ID: $PROGRAM_ID"

# Ensure the admin wallet has SOL (for paying rent/fees during bootstrap).
ADMIN_BAL_SOL=$(solana balance "$ADMIN_PUBKEY" --url "$RPC" | awk '{print $1}')
ADMIN_BAL_INT="$(printf '%.0f' "${ADMIN_BAL_SOL:-0}")"
if [[ "$ADMIN_BAL_INT" -lt 5 ]]; then
  echo "    funding admin with 50 SOL..."
  solana airdrop 50 "$ADMIN_PUBKEY" --url "$RPC" > /dev/null
fi

# ---------------------------------------------------------------------------
# Step 2: deploy program
# ---------------------------------------------------------------------------
echo "[bootstrap-localnet] step 2/4 — deploying program"

DEPLOYED=$(solana program show "$PROGRAM_ID" --url "$RPC" 2>/dev/null | head -1 || true)
if [[ -n "$DEPLOYED" ]]; then
  echo "    program already deployed at $PROGRAM_ID — redeploying (upgrade)"
else
  echo "    program not yet deployed — fresh deploy"
fi

solana program deploy "$PROGRAM_SO" \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$HOME/.config/solana/id.json" \
  --url "$RPC"

echo "    deploy OK"

# ---------------------------------------------------------------------------
# Step 3: provision USDC mint (fresh per bootstrap run if missing)
# ---------------------------------------------------------------------------
echo "[bootstrap-localnet] step 3/4 — provisioning USDC mint"

# If .env.local already has a USDC_MINT and it exists on-chain, reuse it.
EXISTING_MINT=""
if [[ -f "$ENV_LOCAL" ]]; then
  EXISTING_MINT=$(grep -E '^USDC_MINT=' "$ENV_LOCAL" 2>/dev/null | head -1 | cut -d= -f2- || true)
fi

USDC_MINT=""
if [[ -n "$EXISTING_MINT" ]]; then
  if solana account "$EXISTING_MINT" --url "$RPC" > /dev/null 2>&1; then
    echo "    reusing existing USDC mint: $EXISTING_MINT"
    USDC_MINT="$EXISTING_MINT"
  else
    echo "    .env.local has stale USDC mint ($EXISTING_MINT) — creating fresh"
  fi
fi

if [[ -z "$USDC_MINT" ]]; then
  # `spl-token create-token` writes the new mint pubkey to stdout.
  # Use admin keypair as the mint authority so bootstrap.ts can mint to users.
  CREATE_OUT=$(spl-token create-token \
    --decimals 6 \
    --mint-authority "$ADMIN_KEY" \
    --fee-payer "$ADMIN_KEY" \
    --url "$RPC")
  USDC_MINT=$(echo "$CREATE_OUT" | grep -oE 'Address:[[:space:]]+[A-Za-z0-9]+' | awk '{print $2}')
  if [[ -z "$USDC_MINT" ]]; then
    echo "ERROR: failed to parse new mint address from output:" >&2
    echo "$CREATE_OUT" >&2
    exit 1
  fi
  echo "    created fresh USDC mint: $USDC_MINT"

  # Mint 1,000,000 USDC into the admin's ATA — used to fund user wallets in bootstrap.ts.
  spl-token create-account "$USDC_MINT" \
    --owner "$ADMIN_PUBKEY" \
    --fee-payer "$ADMIN_KEY" \
    --url "$RPC" > /dev/null 2>&1 || true
  spl-token mint "$USDC_MINT" 1000000 \
    --mint-authority "$ADMIN_KEY" \
    --recipient-owner "$ADMIN_PUBKEY" \
    --fee-payer "$ADMIN_KEY" \
    --url "$RPC" > /dev/null
  echo "    minted 1,000,000 USDC into admin ATA"
fi

# Persist USDC_MINT + program ID to .env.local (replace existing line, append if absent).
touch "$ENV_LOCAL"
write_env_var() {
  local key="$1"
  local val="$2"
  if grep -qE "^${key}=" "$ENV_LOCAL"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_LOCAL" > "$ENV_LOCAL.tmp"
    mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"
  else
    echo "$key=$val" >> "$ENV_LOCAL"
  fi
}
write_env_var "USDC_MINT" "$USDC_MINT"
write_env_var "NEXT_PUBLIC_USDC_MINT" "$USDC_MINT"
write_env_var "MERIDIAN_PROGRAM_ID" "$PROGRAM_ID"
write_env_var "NEXT_PUBLIC_MERIDIAN_PROGRAM_ID" "$PROGRAM_ID"
echo "    USDC_MINT + program ID written to .env.local"

# ---------------------------------------------------------------------------
# Step 4: hand off to bootstrap.ts (initializes everything on-chain)
# ---------------------------------------------------------------------------
echo "[bootstrap-localnet] step 4/4 — running bootstrap.ts"

# Use the tsx binary from the automation package — already installed.
export USDC_MINT="$USDC_MINT"
export MERIDIAN_PROGRAM_ID="$PROGRAM_ID"
"$REPO_ROOT/automation/node_modules/.bin/tsx" "$REPO_ROOT/scripts/bootstrap.ts"

echo ""
echo "[bootstrap-localnet] done."
