"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import {
  Button,
  CaretMark,
  IconBolt,
  IconClose,
  IconCopy,
  IconExt,
  IconRight,
  Modal,
  Stat,
} from "@/components/caret";
import { fmtUsdDollars, shortKey } from "@/lib/format";
import { env } from "@/lib/env";
import { notify } from "@/lib/notify";
import { useUsdcBalance } from "@/lib/usdc";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Well-known browser-extension wallets we always surface — so when they aren't
// installed we show an "Install" link instead of hiding them entirely.
const KNOWN_EXTERNAL = [
  { name: "Phantom", url: "https://phantom.app/" },
  { name: "Solflare", url: "https://solflare.com/" },
];

/**
 * WalletConnectModal — caret-styled, ports prototype/js/wallet.jsx.
 *
 * Two states:
 *   - Disconnected: list of supported wallets (Phantom, Solflare, and any
 *     Wallet-Standard wallet such as Backpack that the adapter auto-detects)
 *     with installed / not-detected badges.
 *   - Connected: address + cluster, balances, copy / explorer / faucet / disconnect.
 *
 * The project also uses @solana/wallet-adapter-react-ui's modal via
 * `useWalletModal()`. The Header invokes that modal directly. This component
 * exists for callers that prefer the in-app, caret-styled experience.
 */
export function WalletConnectModal({ open, onClose }: Props) {
  const { wallets, select, connect, connected, publicKey, disconnect } = useWallet();
  const usdc = useUsdcBalance();

  // The WalletProvider has `autoConnect`, so selecting a wallet already starts a
  // connection. Reading `connected` inside the async handler would be a stale
  // closure, so mirror it into a ref that an effect keeps current.
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  async function handleConnect(walletName: string) {
    try {
      select(walletName as never);
      // Give the provider a tick to adopt the selection. With autoConnect on it
      // may already be connecting; calling connect() again throws a benign
      // "already connecting/connected" race error — we attempt once and tolerate
      // it, then VERIFY the real connection state below rather than trusting the
      // throw (that double-connect race was surfacing a false "connect failed").
      await new Promise((r) => setTimeout(r, 60));
      try {
        await connect();
      } catch {
        /* benign select→connect race — verified below */
      }
      // Poll for the real connection. Allow ~8s — the "Admin (demo)" wallet
      // fetches its key from /api/admin-key on connect (and Next compiles that
      // route on first hit), which is slower than a local burner.
      for (let i = 0; i < 40 && !connectedRef.current; i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (connectedRef.current) {
        notify.success("Wallet connected");
        onClose();
      } else {
        notify.error("Wallet connect failed — please try again.");
      }
    } catch (err) {
      if (connectedRef.current) {
        onClose();
        return;
      }
      notify.error(
        `Wallet connect failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }

  function copyAddress() {
    if (!publicKey) return;
    try {
      navigator.clipboard?.writeText(publicKey.toBase58());
      notify.success("Address copied");
    } catch {
      notify.warning("Copy failed");
    }
  }

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} w={460}>
      {connected && publicKey ? (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background:
                    "linear-gradient(135deg, var(--accent), oklch(0.6 0.2 290))",
                }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {shortKey(publicKey.toBase58())}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                  Solana · {env.cluster || "localnet"}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent",
                border: 0,
                color: "var(--text-3)",
                padding: 6,
                cursor: "pointer",
              }}
            >
              <IconClose size={14} />
            </button>
          </div>

          <div
            style={{
              padding: "16px 0",
              borderTop: "1px solid var(--line-soft)",
              borderBottom: "1px solid var(--line-soft)",
              marginBottom: 16,
            }}
          >
            <Stat
              k="USDC balance"
              v={usdc.cents != null ? fmtUsdDollars(usdc.cents / 100) : "—"}
            />
            <Stat k="Cluster" v={env.cluster || "localnet"} />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <Button leftIcon={<IconCopy size={12} />} onClick={copyAddress}>
              Copy address
            </Button>
            <Button
              leftIcon={<IconExt size={12} />}
              onClick={() => {
                const cluster = env.cluster || "devnet";
                window.open(
                  `https://solscan.io/account/${publicKey.toBase58()}?cluster=${cluster}`,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              Solscan
            </Button>
            <Button
              leftIcon={<IconBolt size={12} />}
              onClick={() =>
                window.open(
                  "https://faucet.solana.com/",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Devnet faucet
            </Button>
            <Button
              onClick={() => {
                void disconnect();
                onClose();
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              marginBottom: 18,
            }}
          >
            <div>
              <CaretMark size={20} />
              <h3 style={{ marginTop: 14, marginBottom: 4 }}>
                Connect a Solana wallet
              </h3>
              <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                Non-custodial. Meridian never holds your USDC.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent",
                border: 0,
                color: "var(--text-3)",
                padding: 6,
                cursor: "pointer",
                marginTop: -4,
              }}
            >
              <IconClose size={14} />
            </button>
          </div>

          <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
            {wallets.map((w) => {
              const installed =
                w.readyState === "Installed" || w.readyState === "Loadable";
              return (
                <button
                  key={w.adapter.name}
                  type="button"
                  onClick={() => {
                    if (installed) {
                      void handleConnect(w.adapter.name);
                    } else {
                      window.open(w.adapter.url, "_blank", "noopener,noreferrer");
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    background: "var(--bg)",
                    border: "1px solid var(--line-soft)",
                    borderRadius: 10,
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--sans)",
                    transition: "background .12s, border-color .12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "var(--line)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg)";
                    e.currentTarget.style.borderColor = "var(--line-soft)";
                  }}
                >
                  {w.adapter.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={w.adapter.icon}
                      alt=""
                      style={{ width: 28, height: 28, borderRadius: 6 }}
                    />
                  ) : (
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        background:
                          "linear-gradient(135deg, var(--accent), oklch(0.6 0.2 290))",
                      }}
                    />
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      {w.adapter.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-3)",
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {installed ? "Installed" : "Not detected"}
                    </div>
                  </div>
                  {installed ? (
                    <IconRight size={14} style={{ color: "var(--text-3)" }} />
                  ) : (
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--mono)",
                        color: "var(--text-3)",
                      }}
                    >
                      install <IconExt size={10} />
                    </span>
                  )}
                </button>
              );
            })}
            {/* Always surface known browser wallets: if they aren't already
                detected above, show an Install link instead of hiding them. */}
            {KNOWN_EXTERNAL.filter(
              (k) => !wallets.some((w) => w.adapter.name === k.name),
            ).map((k) => (
              <a
                key={k.name}
                href={k.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  background: "var(--bg)",
                  border: "1px solid var(--line-soft)",
                  borderRadius: 10,
                  color: "var(--text)",
                  textDecoration: "none",
                  fontFamily: "var(--sans)",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background:
                      "linear-gradient(135deg, var(--accent), oklch(0.6 0.2 290))",
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{k.name}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    Not installed
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    color: "var(--accent)",
                  }}
                >
                  install <IconExt size={10} />
                </span>
              </a>
            ))}
          </div>

          <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 12, lineHeight: 1.5 }}>
            No extension? Use a <strong style={{ color: "var(--text-2)" }}>Demo Wallet</strong> above
            — no install needed. (A browser extension is only required for
            Phantom/Solflare; embedded social-login wallets are a future option.)
          </div>

          <div
            style={{
              padding: "12px 14px",
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--text-2)",
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "var(--accent)" }}>
              {(env.cluster || "Devnet").toUpperCase()} ·
            </strong>{" "}
            use the in-app faucet for USDC after connecting. No real funds at
            risk.
          </div>
        </div>
      )}
    </Modal>
  );
}
