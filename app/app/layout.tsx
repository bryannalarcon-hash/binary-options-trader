import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Header } from "@/components/Header";
import { Toaster } from "@/components/Toaster";
import { WalletProviderWrapper } from "@/components/WalletProviderWrapper";

import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian — Binary stock outcomes on Solana",
  description:
    "Non-custodial binary options on MAG7 closes. Yes/No tokens sum to $1.00. Settled on-chain via Pyth.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        <WalletProviderWrapper>
          <div className="app">
            <Header />
            <main style={{ flex: 1 }}>{children}</main>
          </div>
          <Toaster />
        </WalletProviderWrapper>
      </body>
    </html>
  );
}
