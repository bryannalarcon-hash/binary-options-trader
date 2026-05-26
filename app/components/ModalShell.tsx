"use client";

import { useEffect, type ReactNode } from "react";

import { IconClose } from "@/components/caret";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * ModalShell — caret-styled common dialog wrapper. Handles ESC + click-outside
 * dismiss + scroll-lock. Used by ConfirmTradeModal, PositionConstraintModal,
 * and RedeemConfirmationModal.
 */
export function ModalShell({ title, onClose, children }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="modal-back"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal" style={{ padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--line-soft)",
            padding: "14px 20px",
          }}
        >
          <h3 style={{ fontSize: 15 }}>{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: 0,
              color: "var(--text-3)",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <IconClose size={16} />
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
