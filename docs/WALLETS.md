# Meridian — Wallet Reference

> **DO NOT commit this file's pubkeys to any public repo as "test keys."**
> They're devnet-only and not financially risky, but treat them as project identifiers — don't paste them into public bug reports.
> The keypair JSON files themselves are gitignored (`keys/` in `.gitignore`).

---

## The four wallets

| Role | Pubkey | Keypair file | Needs |
|---|---|---|---|
| **Dev wallet** (Anchor deploys) | `7VDBVfpRi1MJWie8nwh9Xe8aWHdYZtMxBqZoKRMCexV9` | `~/.config/solana/id.json` | **~3 SOL** for program deploy + tx fees |
| **Admin authority** | `6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM` | `keys/admin.json` | **~1 SOL** for admin instructions (pause, override settle, add strike) |
| **Automation service** | `7ftxc24p61R3cJH212QAfNpoVLQfGLGU4oyMhzzG8Ufk` | `keys/automation.json` | **~2 SOL** for daily morning + settlement jobs |
| **Fee destination** | `VWqmqDBLxnTSYPJaiKFKAfUqt1tk4rrBXWb2RFjVrU8` | `keys/fee_destination.json` | **0 SOL** — only receives fees |

---

## How to fund them on devnet (when the public faucet recovers)

The public devnet airdrop pool was depleted at the time these wallets were generated. The faucet refills periodically. When you want to fund:

### Option 1: Web faucet (humans only — CAPTCHA-gated)
1. Open https://faucet.solana.com
2. Make sure "Devnet" is selected
3. Paste a pubkey (one at a time)
4. Request the SOL amount listed above
5. Repeat for each wallet

### Option 2: CLI airdrop (when rate limit recovers)
```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

solana airdrop 3 7VDBVfpRi1MJWie8nwh9Xe8aWHdYZtMxBqZoKRMCexV9 --url devnet
solana airdrop 1 6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM --url devnet
solana airdrop 2 7ftxc24p61R3cJH212QAfNpoVLQfGLGU4oyMhzzG8Ufk --url devnet
```

### Option 3: PoW miner (once a wallet has any SOL at all)
`devnet-pow` is already installed at `~/.cargo/bin/devnet-pow`. It requires the wallet to already have some SOL to pay claim-tx fees, so it's a *top-up* tool, not a cold-start funder.

```bash
devnet-pow mine -d 3 --reward 0.02 --no-infer -t 3000000000
```

### Devnet USDC (for the dev wallet, for testing mint_pair)
Mint address: `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` (6 decimals)

Faucet: https://spl-token-faucet.com/?token-name=USDC-Dev

You'll need devnet USDC in the dev wallet to test `mint_pair` end-to-end.

---

## Verifying balances anytime

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

for label_pubkey in \
  "Dev:7VDBVfpRi1MJWie8nwh9Xe8aWHdYZtMxBqZoKRMCexV9" \
  "Admin:6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM" \
  "Auto:7ftxc24p61R3cJH212QAfNpoVLQfGLGU4oyMhzzG8Ufk" \
  "Fee:VWqmqDBLxnTSYPJaiKFKAfUqt1tk4rrBXWb2RFjVrU8" \
; do
  label="${label_pubkey%%:*}"
  pk="${label_pubkey#*:}"
  echo "$label ($pk): $(solana balance $pk --url devnet 2>&1)"
done
```

---

## Importing into Phantom / Solflare / Backpack (if you want a GUI wallet)

You can import any of these keypairs into a browser wallet for manual UX testing:

1. Open the keypair JSON file (e.g., `cat ~/.config/solana/id.json`) — it's a 64-byte byte-array.
2. In Phantom: Settings → "Add / Connect Wallet" → "Import Private Key" → paste the byte-array.
3. Switch the wallet network to **Devnet** in Phantom settings.
4. The pubkey shown in the wallet should match the corresponding entry above.

---

## Replacing wallets later

If a keypair gets compromised or you just want fresh ones:

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

solana-keygen new --no-bip39-passphrase --silent --force --outfile keys/admin.json
solana-keygen pubkey keys/admin.json   # update ADMIN_PUBKEY in .env
```

Then re-fund the new pubkey and update `.env`.

---

## Local-validator alternative (no devnet SOL needed)

For development work where you don't need real devnet, use the local validator and airdrop unlimited SOL locally. See `scripts/dev-localnet.sh`.
