"use client";

import type { CSSProperties, ReactNode } from "react";

export function Label({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="label" style={style}>
      {children}
    </div>
  );
}
