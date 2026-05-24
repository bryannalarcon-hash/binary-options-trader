"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  ArrowRight,
  Check,
  Coins,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";

import { TickerStrip } from "@/components/TickerStrip";
import { useMounted } from "@/lib/use-mounted";

/**
 * Landing page (`/`).
 *
 * Implements IMPLEMENTATION_PLAN §16.1 and the PRD's landing requirements:
 *   - Hero with tagline + sub-tagline (verbatim PRD copy)
 *   - "Connect Wallet" CTA → wallet modal; on success redirects via
 *     header state; CTA secondarily routes to /markets
 *   - "Browse Markets" CTA → /markets
 *   - Live ticker strip (TickerStrip, animated)
 *   - How-it-works panel (3 steps)
 */
export default function LandingPage() {
  const mounted = useMounted();
  const wallet = useWallet();
  const connected = mounted && wallet.connected;
  const walletModal = useWalletModal();

  return (
    <div className="-mx-6 -my-8">
      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-br from-bg via-bg to-surface px-6 py-20">
        <div className="mx-auto max-w-7xl">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs uppercase tracking-wider text-zinc-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-yes" />
            MAG7 — Settled at the close — Pyth-powered
          </div>
          <h1 className="text-balance text-5xl font-semibold tracking-tight md:text-6xl">
            Binary stock outcomes.
            <br />
            <span className="text-accent">On chain.</span> Settled at the close.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-zinc-400">
            Trade Yes/No tokens on whether MAG7 stocks close above today&apos;s
            strike. Non-custodial. Pyth-powered. Yes + No = $1.00, always.
          </p>
          <p className="mt-3 max-w-2xl text-sm text-zinc-500">
            Each Yes token is a digital cash-or-nothing call on AAPL, MSFT,
            GOOGL, AMZN, NVDA, META, TSLA — strike K, expiry today&apos;s close.
            Price equals risk-neutral probability P(S<sub>T</sub> ≥ K).
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {connected ? (
              <Link
                href="/markets"
                className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-bg hover:opacity-90"
              >
                Go to Markets <ArrowRight size={14} />
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => walletModal.setVisible(true)}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-bg hover:opacity-90"
              >
                Connect Wallet <ArrowRight size={14} />
              </button>
            )}
            <Link
              href="/markets"
              className="rounded-md border border-border px-5 py-2.5 text-sm font-medium text-zinc-200 hover:bg-surface"
            >
              Browse Markets
            </Link>
          </div>
        </div>
      </section>

      {/* Live ticker strip */}
      <TickerStrip />

      {/* How it works */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-7xl">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            How it works
          </h2>
          <p className="mt-2 text-3xl font-semibold tracking-tight">
            One question. One day. One outcome.
          </p>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <Step
              icon={<TrendingUp size={20} />}
              num="01"
              title="Pick a strike"
              body="Each MAG7 ticker has 7 strikes daily (±3/6/9% around yesterday's close). Pick the one that matches your view."
            />
            <Step
              icon={<Coins size={20} />}
              num="02"
              title="Trade Yes / No"
              body="Yes pays $1.00 if the stock closes at-or-above strike. No pays $1.00 if it doesn't. Yes + No = $1.00, always."
            />
            <Step
              icon={<ShieldCheck size={20} />}
              num="03"
              title="Settle at 4 PM ET"
              body="Pyth Network publishes the close. The smart contract settles. Winners redeem $1.00 per token, on-chain."
            />
          </div>
          <div className="mt-12 grid gap-3 rounded-lg border border-border bg-surface p-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">
                What you get
              </h3>
              <ul className="mt-3 space-y-2 text-sm text-zinc-400">
                {[
                  "Non-custodial — keys stay in your wallet",
                  "Phantom, Solflare, Backpack supported",
                  "Settles via Pyth — same publisher set as Jane Street + Jump",
                  "Sub-second order book on Phoenix CLOB",
                  "Atomic close-and-reverse — one wallet click",
                ].map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <Check size={14} className="mt-0.5 text-yes" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">
                Live demo
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                Connect a wallet on Solana localnet/devnet to try it.
                Use the in-app USDC faucet on devnet, or hit the local validator
                with <code className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs">make airdrop</code>.
              </p>
              <Link
                href="/markets"
                className="mt-4 inline-flex items-center gap-2 text-sm text-accent hover:underline"
              >
                Browse the live markets <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-bg/60 px-6 py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-2 text-xs text-zinc-500 md:flex-row md:items-center">
          <span>© Meridian — non-custodial binary options on Solana</span>
          <div className="flex gap-4">
            <a href="https://github.com" className="hover:text-zinc-300">GitHub</a>
            <a href="https://pyth.network" className="hover:text-zinc-300">Pyth</a>
            <span>v0.1.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Step({
  icon,
  num,
  title,
  body,
}: {
  icon: React.ReactNode;
  num: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="rounded-md bg-accent/10 p-2 text-accent">{icon}</div>
        <span className="font-mono text-xs text-zinc-500">{num}</span>
      </div>
      <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm text-zinc-400">{body}</p>
    </div>
  );
}
