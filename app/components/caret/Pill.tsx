"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: "default" | "up" | "dn" | "accent";
}

export function Pill({ children, tone = "default", className, style, ...rest }: Props) {
  const toneCls =
    tone === "up" ? "up" : tone === "dn" ? "dn" : tone === "accent" ? "accent" : "";
  return (
    <span className={`pill ${toneCls} ${className ?? ""}`.trim()} style={style} {...rest}>
      {children}
    </span>
  );
}

interface StrikePillProps {
  tone?: "atm" | "win" | "loss";
  children: ReactNode;
}

export function StrikePill({ tone, children }: StrikePillProps) {
  const map: Record<string, { bg: string; color: string; border: string }> = {
    atm: { bg: "var(--accent-soft)", color: "var(--accent)", border: "var(--accent-line)" },
    win: { bg: "var(--up-soft)", color: "var(--up)", border: "var(--up-line)" },
    loss: { bg: "var(--down-soft)", color: "var(--down)", border: "var(--down-line)" },
  };
  const s = tone
    ? map[tone] ?? { bg: "var(--bg-elev-2)", color: "var(--text-3)", border: "var(--line)" }
    : { bg: "var(--bg-elev-2)", color: "var(--text-3)", border: "var(--line)" };
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 6px",
    borderRadius: 4,
    fontFamily: "var(--mono)",
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    background: s.bg,
    color: s.color,
    border: `1px solid ${s.border}`,
  };
  return <span style={style}>{children}</span>;
}
