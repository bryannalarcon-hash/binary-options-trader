"use client";

import { Toaster as HotToaster } from "react-hot-toast";

/** Global toast container — wraps react-hot-toast with Meridian-themed styles. */
export function Toaster() {
  return (
    <HotToaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: "#121214",
          color: "#f4f4f5",
          border: "1px solid #26262b",
          fontSize: "14px",
        },
      }}
    />
  );
}
