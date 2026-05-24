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
    <html lang="en">
      <body className="min-h-screen bg-bg text-zinc-100 antialiased">
        <WalletProviderWrapper>
          <Header />
          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
          <Toaster />
        </WalletProviderWrapper>
      </body>
    </html>
  );
}
