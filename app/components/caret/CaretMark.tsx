"use client";

interface Props {
  size?: number;
  color?: string;
}

/** The caret brand glyph — 24×24 chevron in the accent color. */
export function CaretMark({ size = 24, color }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ display: "block" }}
    >
      <path
        d="M8 5 L16 12 L8 19"
        stroke={color || "var(--accent)"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
