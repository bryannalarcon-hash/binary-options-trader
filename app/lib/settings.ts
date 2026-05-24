/**
 * User-level UI settings persisted in localStorage.
 * Read by SettingsPanel (§17.4), TradePanel (slippage), ConfirmTradeModal
 * (first-3-trades counter), portfolio (auto-redeem), header (theme).
 */

"use client";

import { useEffect, useState, useCallback } from "react";

const KEY = "meridian:settings:v1";

export interface MeridianSettings {
  autoRedeem: boolean;
  confirmTradeModal: boolean;
  slippageBps: number; // 100 = 1%
  theme: "system" | "light" | "dark";
  /** how many trades the user has placed (to know when to skip confirm modal). */
  tradesCompleted: number;
}

export const DEFAULT_SETTINGS: MeridianSettings = {
  autoRedeem: true,
  confirmTradeModal: true,
  slippageBps: 100,
  theme: "dark",
  tradesCompleted: 0,
};

function readSettings(): MeridianSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<MeridianSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(s: MeridianSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
    // notify all hooks in this tab
    window.dispatchEvent(new CustomEvent("meridian:settings-changed"));
  } catch {
    // ignore quota / private-mode errors
  }
}

/**
 * React hook for the settings record. All subscribers stay in sync across
 * tabs (via storage event) and within-tab (via custom event).
 */
export function useSettings(): [
  MeridianSettings,
  (partial: Partial<MeridianSettings>) => void,
  () => void,
] {
  const [settings, setSettings] = useState<MeridianSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettings(readSettings());
    const onChange = () => setSettings(readSettings());
    window.addEventListener("storage", onChange);
    window.addEventListener("meridian:settings-changed", onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener("meridian:settings-changed", onChange);
    };
  }, []);

  const update = useCallback((partial: Partial<MeridianSettings>) => {
    const next = { ...readSettings(), ...partial };
    writeSettings(next);
    setSettings(next);
  }, []);

  const reset = useCallback(() => {
    writeSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return [settings, update, reset];
}

/** Bump the trade counter (called after a successful trade). */
export function bumpTradeCount(): void {
  const s = readSettings();
  writeSettings({ ...s, tradesCompleted: s.tradesCompleted + 1 });
}
