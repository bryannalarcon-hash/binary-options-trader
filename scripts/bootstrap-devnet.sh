#!/usr/bin/env bash
# Bootstrap Meridian on DEVNET.
#
# Assumes:
#   - .env points at devnet
#   - meridian program already deployed (MERIDIAN_PROGRAM_ID set in .env)
#   - keys/admin.json funded with >= 0.5 SOL
#
# Idempotent — safe to re-run.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# Load env (no .env.local on devnet).
set -a
# shellcheck source=/dev/null
source "$REPO_ROOT/.env"
set +a

: "${SOLANA_RPC_URL:?SOLANA_RPC_URL not set in .env}"
: "${MERIDIAN_PROGRAM_ID:?MERIDIAN_PROGRAM_ID not set in .env}"
: "${USDC_MINT:?USDC_MINT not set in .env}"

echo "[bootstrap-devnet.sh] RPC: $SOLANA_RPC_URL"
echo "[bootstrap-devnet.sh] Program: $MERIDIAN_PROGRAM_ID"
echo "[bootstrap-devnet.sh] USDC: $USDC_MINT"

# Verify program is deployed (don't redeploy here — that's a separate step).
echo "[bootstrap-devnet.sh] verifying program deployment..."
if ! solana program show "$MERIDIAN_PROGRAM_ID" --url "$SOLANA_RPC_URL" >/dev/null 2>&1; then
  echo "[bootstrap-devnet.sh] FATAL: program $MERIDIAN_PROGRAM_ID not deployed."
  echo "    Run: solana program deploy target/deploy/meridian.so \\"
  echo "         --program-id target/deploy/meridian-keypair.json \\"
  echo "         --url \$SOLANA_RPC_URL"
  exit 1
fi

# Run TS bootstrap (config + oracles + markets).
echo "[bootstrap-devnet.sh] running TS bootstrap..."
pnpm tsx "$REPO_ROOT/scripts/bootstrap-devnet.ts"

echo ""
echo "[bootstrap-devnet.sh] Done. To trade, the dev wallet needs USDC:"
echo "    -> https://spl-token-faucet.com/?token-name=USDC-Dev"
echo "    (paste wallet pubkey, claim 100 USDC-Dev)"
