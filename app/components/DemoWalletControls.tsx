"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { Button, Modal, IconCopy } from "@/components/caret";
import {
  burnerWalletName,
  burnerIndexFromName,
  getBurnerSecretBase58,
} from "@/lib/burner-wallet";
import { fundDemoWallet } from "@/lib/faucet";
import { notify } from "@/lib/notify";
import { shortKey } from "@/lib/format";

/**
 * Header control for managing a connected demo (burner) wallet: switch between
 * Demo Wallet 1/2, reveal the secret key for importing into Phantom/Solflare,
 * top up devnet SOL + USDC, and disconnect. Renders nothing unless a demo
 * wallet is currently connected (external wallets manage themselves).
 */
export function DemoWalletControls() {
  const wallet = useWallet();
  const name = wallet.wallet?.adapter?.name;
  const index = burnerIndexFromName(name);
  const publicKey = wallet.publicKey;
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (index == null || !publicKey) return null;
  const other = index === 1 ? 2 : 1;

  function close() {
    setOpen(false);
    setRevealed(null);
  }

  async function switchTo(target: number) {
    setBusy(true);
    try {
      await wallet.disconnect();
      await new Promise((r) => setTimeout(r, 80));
      wallet.select(burnerWalletName(target));
      await new Promise((r) => setTimeout(r, 120));
      await wallet.connect();
      setRevealed(null);
      notify.success(`Switched to Demo Wallet ${target}`);
    } catch (err) {
      notify.error(`Switch failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  function reveal() {
    const k = getBurnerSecretBase58(index!);
    if (!k) {
      notify.warning("No key found — connect the demo wallet first.");
      return;
    }
    setRevealed(k);
  }

  async function topUp() {
    setBusy(true);
    const r = await fundDemoWallet(publicKey!.toBase58());
    setBusy(false);
    if (r.ok) notify.success(`Topped up · ${r.usdc ?? 1000} USDC`);
    else notify.error(`Top up failed: ${r.error ?? "unknown"}`);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Manage demo wallet"
        style={{
          padding: "6px 10px",
          background: "var(--bg-elev)",
          border: "1px solid var(--line-soft)",
          borderRadius: 999,
          color: "var(--text-2)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        Demo {index} ⚙
      </button>

      {open && (
        <Modal open={open} onClose={close} w={460}>
          <h3 style={{ marginBottom: 4 }}>Demo Wallet {index}</h3>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 16, fontFamily: "var(--mono)" }}>
            {shortKey(publicKey.toBase58())} · devnet demo funds only
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Button primary onClick={() => void topUp()} disabled={busy}>
              {busy ? "Funding…" : "Fund demo wallet"}
            </Button>
            <Button onClick={() => void switchTo(other)} disabled={busy}>
              Switch to Demo {other}
            </Button>
            <Button onClick={reveal}>Reveal secret key</Button>
            <Button
              onClick={() => {
                void wallet.disconnect();
                close();
              }}
            >
              Disconnect
            </Button>
          </div>

          {revealed && (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                background: "var(--down-soft)",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5, marginBottom: 8 }}>
                <strong style={{ color: "var(--down)" }}>Secret key (base58).</strong>{" "}
                In Phantom: <em>Settings → Manage Accounts → Add / Connect Wallet →
                Import Private Key</em>, then paste this. The same demo wallet will
                then exist in your extension. <strong>Devnet demo only — never reuse
                for real funds.</strong>
              </div>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  wordBreak: "break-all",
                  background: "var(--bg)",
                  border: "1px solid var(--line-soft)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  color: "var(--text)",
                }}
              >
                {revealed}
              </div>
              <div style={{ marginTop: 8 }}>
                <Button
                  leftIcon={<IconCopy size={12} />}
                  onClick={() => {
                    try {
                      void navigator.clipboard?.writeText(revealed);
                      notify.success("Secret key copied");
                    } catch {
                      notify.warning("Copy failed — select the text manually");
                    }
                  }}
                >
                  Copy key
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
