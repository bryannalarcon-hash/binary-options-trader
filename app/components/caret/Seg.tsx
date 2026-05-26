"use client";

import type { ReactNode } from "react";

export type SegOption<T extends string> = T | { value: T; label: ReactNode };

interface Props<T extends string> {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (v: T) => void;
}

export function Seg<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="seg">
      {options.map((o) => {
        const key = typeof o === "string" ? o : o.value;
        const label = typeof o === "string" ? o : o.label;
        return (
          <button
            key={key}
            type="button"
            className={value === key ? "on" : ""}
            onClick={() => onChange(key)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
