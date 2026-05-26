"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  w?: number;
}

export function Modal({ open, onClose, children, w = 440 }: Props) {
  // Render into <body> via a portal so the fixed-position backdrop escapes any
  // ancestor stacking context / containing block. The header is
  // `position: sticky; z-index: 100` with a `backdrop-filter`, which (per spec)
  // makes it the containing block for `position: fixed` descendants AND a
  // stacking context — so a modal rendered inline inside the header (e.g. the
  // demo-wallet panel) would be positioned relative to the header and capped at
  // z-index 100, painting BEHIND the page. The portal fixes that.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: w }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
