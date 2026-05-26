"use client";

import type { ReactNode } from "react";

import { Button } from "./Button";
import { CaretMark } from "./CaretMark";

interface Props {
  title: string;
  desc: string;
  cta?: string;
  onCta?: () => void;
  icon?: ReactNode;
}

export function EmptyState({ title, desc, cta, onCta, icon }: Props) {
  return (
    <div
      style={{
        padding: "80px 32px",
        border: "1px dashed var(--line-soft)",
        borderRadius: 12,
        textAlign: "center",
        background: "var(--bg-elev)",
      }}
    >
      {icon ?? <CaretMark size={32} color="var(--text-4)" />}
      <h3 style={{ marginTop: 18, marginBottom: 8 }}>{title}</h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-3)",
          maxWidth: 380,
          margin: "0 auto 20px",
        }}
      >
        {desc}
      </p>
      {cta && onCta && (
        <Button primary onClick={onCta}>
          {cta}
        </Button>
      )}
    </div>
  );
}
