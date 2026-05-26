"use client";

import { CaretMark } from "./CaretMark";

interface Props {
  size?: number;
  label?: string;
}

/**
 * Brand wordmark — chevron + lowercase "meridian" (or override label).
 *
 * Note: we keep "meridian" as the live wordmark for the production app even
 * though the design handoff sometimes uses "caret" — caret is the design
 * system name; meridian is the product.
 */
export function Wordmark({ size = 18, label = "meridian" }: Props) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <CaretMark size={size + 4} />
      <span
        style={{
          fontFamily: "var(--sans)",
          fontWeight: 600,
          fontSize: size,
          letterSpacing: "-0.015em",
          color: "var(--text)",
        }}
      >
        {label}
      </span>
    </div>
  );
}
