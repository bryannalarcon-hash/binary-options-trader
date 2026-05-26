"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: number | string;
  flat?: boolean;
}

export function Card({ children, padding = 18, flat, style, className, ...rest }: CardProps) {
  return (
    <div
      className={`${flat ? "card-flat" : "card"} ${className ?? ""}`.trim()}
      style={{ padding, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

interface SectionTitleProps {
  children: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}

export function SectionTitle({ children, action, style }: SectionTitleProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
        ...style,
      }}
    >
      <h4 style={{ color: "var(--text)" }}>{children}</h4>
      {action}
    </div>
  );
}
