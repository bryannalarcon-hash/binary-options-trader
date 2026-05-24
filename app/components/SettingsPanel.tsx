"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

import { env } from "@/lib/env";
import { useSettings } from "@/lib/settings";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * SettingsPanel — right-edge slide-over (§17.4).
 * Toggles persist immediately to localStorage via useSettings().
 */
export function SettingsPanel({ open, onClose }: Props) {
  const [settings, update, reset] = useSettings();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-sm transform border-l border-border bg-surface shadow-xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-bg/60 hover:text-zinc-100"
            aria-label="Close settings"
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-5 overflow-y-auto px-4 py-5 text-sm">
          <Section title="Trading">
            <Toggle
              label="Auto-redeem after settlement"
              hint="Settled winning positions auto-redeem to USDC."
              checked={settings.autoRedeem}
              onChange={(v) => update({ autoRedeem: v })}
            />
            <Toggle
              label="Confirm-trade modal"
              hint="Show recap dialog for the first 3 trades."
              checked={settings.confirmTradeModal}
              onChange={(v) => update({ confirmTradeModal: v })}
            />
            <NumberRow
              label="Default slippage"
              suffix="%"
              value={settings.slippageBps / 100}
              onChange={(v) =>
                update({ slippageBps: Math.max(0, Math.round(v * 100)) })
              }
              step={0.1}
              min={0}
            />
          </Section>

          <Section title="Appearance">
            <SelectRow
              label="Theme"
              value={settings.theme}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
              onChange={(v) => update({ theme: v as "system" | "light" | "dark" })}
            />
          </Section>

          <Section title="Network">
            <div className="flex items-center justify-between text-zinc-400">
              <span>Cluster</span>
              <span className="rounded border border-border bg-bg/40 px-2 py-1 text-xs uppercase tracking-wider">
                {env.cluster || "localnet"}
              </span>
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>RPC</span>
              <span className="truncate text-right font-mono text-[10px] text-zinc-500" title={env.rpcUrl}>
                {env.rpcUrl || "—"}
              </span>
            </div>
          </Section>

          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => {
                reset();
              }}
              className="w-full rounded-md border border-border px-3 py-2 text-xs text-zinc-300 hover:bg-bg/60"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 text-sm">
      <span>
        <span className="block text-zinc-200">{label}</span>
        {hint && <span className="block text-[11px] text-zinc-500">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-accent"
      />
    </label>
  );
}

function NumberRow({
  label,
  suffix,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  suffix?: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-zinc-200">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right font-mono text-sm outline-none focus:border-accent"
        />
        {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
      </span>
    </label>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-zinc-200">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
