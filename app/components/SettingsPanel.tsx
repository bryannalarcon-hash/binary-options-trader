"use client";

import { useEffect, type ReactNode } from "react";

import { IconClose, Label, Seg, Button } from "@/components/caret";
import { env } from "@/lib/env";
import { useSettings } from "@/lib/settings";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * SettingsPanel — caret-styled right-edge slide-over (ports prototype/js/settings.jsx).
 *
 * Persists all changes to localStorage via useSettings(). The "Light" theme
 * sets `data-theme="light"` on <html>, picking up the CSS variable overrides
 * in globals.css.
 */
export function SettingsPanel({ open, onClose }: Props) {
  const [settings, update, reset] = useSettings();

  // Apply theme to document root on change (so the whole app re-paints).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (settings.theme === "light") {
      root.setAttribute("data-theme", "light");
    } else if (settings.theme === "dark") {
      root.setAttribute("data-theme", "dark");
    } else {
      // system — match the user's preference
      const mql = window.matchMedia("(prefers-color-scheme: light)");
      root.setAttribute("data-theme", mql.matches ? "light" : "dark");
    }
  }, [settings.theme]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "oklch(0 0 0 / 0.4)",
          backdropFilter: "blur(4px)",
          zIndex: 8999,
        }}
      />
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: "100vw",
          zIndex: 9000,
          background: "var(--bg-elev)",
          borderLeft: "1px solid var(--line)",
          boxShadow: "-20px 0 60px rgba(0,0,0,.3)",
          display: "flex",
          flexDirection: "column",
          animation: "slideIn .18s ease-out",
        }}
      >
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid var(--line-soft)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3>Settings</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            style={{
              background: "transparent",
              border: 0,
              color: "var(--text-3)",
              cursor: "pointer",
              padding: 6,
            }}
          >
            <IconClose size={14} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "8px 24px 24px" }}>
          <Section title="Trading">
            <SettingRow
              label="Confirm-trade modal"
              desc="Show recap dialog for the first 3 trades."
              value={
                <Toggle
                  on={settings.confirmTradeModal}
                  onChange={(v) => update({ confirmTradeModal: v })}
                />
              }
            />
            <SettingRow
              label="Auto-redeem after settlement"
              desc="Settled winning positions auto-redeem to USDC."
              value={
                <Toggle
                  on={settings.autoRedeem}
                  onChange={(v) => update({ autoRedeem: v })}
                />
              }
            />
            <SettingRow
              label="Default slippage"
              desc="Used for market orders."
              value={
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    step={0.1}
                    value={settings.slippageBps / 100}
                    onChange={(e) =>
                      update({
                        slippageBps: Math.max(
                          0,
                          Math.round(Number(e.target.value) * 100),
                        ),
                      })
                    }
                    style={{ width: 72, height: 32, textAlign: "right" }}
                  />
                  <span
                    style={{
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                    }}
                  >
                    %
                  </span>
                </div>
              }
            />
            <SettingRow
              label="Default quick-bet size"
              desc="Used by Yes/No quick-bet chips on Markets."
              value={
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number"
                    min={1}
                    value={settings.defaultBetSizeUsd}
                    onChange={(e) =>
                      update({
                        defaultBetSizeUsd: Math.max(
                          1,
                          Math.round(Number(e.target.value)),
                        ),
                      })
                    }
                    style={{ width: 72, height: 32, textAlign: "right" }}
                  />
                  <span
                    style={{
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                    }}
                  >
                    USDC
                  </span>
                </div>
              }
            />
          </Section>

          <Section title="Appearance">
            <SettingRow
              label="Theme"
              desc="Light/dark/system."
              value={
                <Seg
                  options={[
                    { value: "dark", label: "Dark" },
                    { value: "light", label: "Light" },
                    { value: "system", label: "Auto" },
                  ]}
                  value={settings.theme}
                  onChange={(v) =>
                    update({ theme: v as "system" | "light" | "dark" })
                  }
                />
              }
            />
          </Section>

          <Section title="Network">
            <SettingRow
              label="Cluster"
              value={
                <span
                  className="pill"
                  style={{
                    textTransform: "uppercase",
                    fontSize: 11,
                  }}
                >
                  {env.cluster || "localnet"}
                </span>
              }
            />
            <SettingRow
              label="RPC endpoint"
              value={
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--text-3)",
                    maxWidth: 220,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    direction: "rtl",
                  }}
                  title={env.rpcUrl}
                >
                  {env.rpcUrl || "—"}
                </span>
              }
            />
          </Section>

          <Section title="Notifications">
            <SettingRow
              label="Order fills"
              value={<Toggle on={true} onChange={() => {}} />}
            />
            <SettingRow
              label="Settlement alerts"
              value={<Toggle on={true} onChange={() => {}} />}
            />
            <SettingRow
              label="Strike chain updates"
              value={<Toggle on={false} onChange={() => {}} />}
            />
          </Section>

          <div
            style={{
              marginTop: 24,
              padding: 14,
              background: "var(--bg-elev-2)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--text-3)",
              lineHeight: 1.5,
            }}
          >
            <div className="label" style={{ marginBottom: 8 }}>
              Risks &amp; limitations
            </div>
            Settlement depends on the Pyth oracle being live within 15 minutes of
            4:00 PM ET. In the rare case of failure, the admin override is
            time-gated by 1 hour. No regulatory or compliance claims are made.
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 20,
              gap: 10,
            }}
          >
            <Button ghost onClick={() => reset()}>
              Reset to defaults
            </Button>
            <Button primary onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 24 }}>
      <Label style={{ marginBottom: 6 }}>{title}</Label>
      <div>{children}</div>
    </div>
  );
}

function SettingRow({
  label,
  desc,
  value,
}: {
  label: string;
  desc?: string;
  value: ReactNode;
}) {
  return (
    <div className="set-row">
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, color: "var(--text)" }}>{label}</div>
        {desc && (
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
            {desc}
          </div>
        )}
      </div>
      <div>{value}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      style={{
        width: 36,
        height: 22,
        borderRadius: 999,
        background: on ? "var(--accent)" : "var(--bg-elev-2)",
        border: "1px solid " + (on ? "var(--accent)" : "var(--line)"),
        position: "relative",
        cursor: "pointer",
        padding: 0,
        transition: "background .12s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: on ? "var(--accent-ink)" : "var(--text-3)",
          transition: "left .12s",
        }}
      />
    </button>
  );
}
