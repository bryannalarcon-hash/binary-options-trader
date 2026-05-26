"use client";

import type { ReactNode } from "react";

interface Props {
  k: ReactNode;
  v: ReactNode;
  vColor?: string;
}

export function Stat({ k, v, vColor }: Props) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 16,
        padding: "5px 0",
      }}
    >
      <span style={{ color: "var(--text-3)", fontSize: 13 }}>{k}</span>
      <span
        className="mono"
        style={{ color: vColor || "var(--text)", fontSize: 13 }}
      >
        {v}
      </span>
    </div>
  );
}
