"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import {
  Button,
  CaretMark,
  Card,
  IconCaret,
  IconCheck,
  fmt$,
} from "@/components/caret";
import { MarketOddsHero } from "@/components/MarketOddsHero";
import { useSpotPrice, useStrikeList } from "@/lib/markets-client";
import { useMounted } from "@/lib/use-mounted";
import { MAG7_TICKERS, TICKER_NAME, type Ticker } from "@/lib/tickers";

/**
 * Pick the headline (ATM) strike + yes price for a ticker from REAL data:
 *   - strikes from `useStrikeList` (derived from real markets + book mids),
 *   - spot from the on-chain OracleAccount via `useSpotPrice`.
 * Returns nulls while loading; the UI renders "—" rather than a fake number.
 */
function useFeatured(ticker: Ticker): {
  ticker: Ticker;
  strikeCents: number | null;
  strikeDisplay: string;
  spotDollars: number | null;
  yes: number | null;
  estimated: boolean;
  loading: boolean;
} {
  const { rows, loading } = useStrikeList(ticker);
  const { spotUsd } = useSpotPrice(ticker);
  const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;

  let atm = rows[0] ?? null;
  if (spotCents != null && rows.length > 0) {
    atm = rows.reduce((best, r) =>
      Math.abs(r.strike - spotCents) < Math.abs(best.strike - spotCents) ? r : best,
    );
  }
  return {
    ticker,
    strikeCents: atm?.strike ?? null,
    strikeDisplay: atm ? `$${(atm.strike / 100).toFixed(0)}` : "—",
    spotDollars: spotUsd,
    yes: atm?.yesCents ?? null,
    estimated: atm?.estimated ?? false,
    loading: loading && rows.length === 0,
  };
}

/**
 * Landing — approachable-retail redesign, REAL on-chain data only.
 *
 *   - Hero + featured card read the live ATM strike / yes price from
 *     `useStrikeList` and the oracle spot from `useSpotPrice`.
 *   - The markets list reads one real ATM row per MAG7 ticker; honest
 *     "—" / estimate marking is preserved.
 */
export default function LandingPage() {
  const mounted = useMounted();
  const wallet = useWallet();
  const walletModal = useWalletModal();
  const connected = mounted && wallet.connected;

  function connectWallet() {
    if (!connected) walletModal.setVisible(true);
  }

  return (
    <div>
      {/* ───────────────────────── HERO ─────────────────────────
          Plain-language value prop a non-expert grasps in 5 seconds,
          paired with one live featured market. Calm, centered, generous
          whitespace — matching the redesigned trade screen. */}
      <section style={{ padding: "72px 0 8px" }}>
        <div
          className="page"
          style={{
            paddingBottom: 0,
            maxWidth: 920,
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <h1
            style={{
              fontSize: "clamp(30px, 5vw, 46px)",
              lineHeight: 1.12,
              letterSpacing: "-0.02em",
              color: "var(--text)",
              margin: 0,
              maxWidth: 720,
            }}
          >
            Bet yes or no on where a big stock closes today.
          </h1>

          <p
            style={{
              fontSize: 18,
              lineHeight: 1.55,
              color: "var(--text-2)",
              maxWidth: 580,
              margin: "20px 0 0",
            }}
          >
            Pick a stock and a price. Say whether it closes at or above that
            price by the end of the day. The winning side pays $1 per share.
          </p>

          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              justifyContent: "center",
              marginTop: 30,
            }}
          >
            <Link
              href="/markets"
              className="btn primary lg"
              style={{ textDecoration: "none" }}
            >
              Browse markets
              <IconCaret size={12} />
            </Link>
            {!connected && (
              <Button lg onClick={connectWallet}>
                Connect wallet
              </Button>
            )}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              marginTop: 26,
              fontSize: 13,
              color: "var(--text-3)",
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <Trust>Your wallet, your funds</Trust>
            <Dot />
            <Trust>Settled by Pyth at the close</Trust>
            <Dot />
            <Trust>Most you can lose is what you pay</Trust>
          </div>

          <MarketOddsHero />
        </div>
      </section>

      {/* ───────────────────────── MARKETS ─────────────────────────
          One scannable row per MAG7 ticker — spot, the at-the-money
          price, and a clear Yes/No, each an obvious click into the market. */}
      <section className="page" style={{ paddingTop: 56, maxWidth: 760 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 16,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 22, letterSpacing: "-0.01em" }}>
            Today&apos;s markets
          </h2>
          <Link
            href="/markets"
            style={{
              fontSize: 14,
              color: "var(--text-2)",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            See all <IconCaret size={11} />
          </Link>
        </div>

        <Card padding={0} style={{ overflow: "hidden" }}>
          {MAG7_TICKERS.map((t, i) => (
            <MarketRow key={t} ticker={t} first={i === 0} />
          ))}
        </Card>

        <p
          style={{
            fontSize: 12.5,
            color: "var(--text-3)",
            marginTop: 12,
            lineHeight: 1.5,
          }}
        >
          Prices are cents on the dollar and read as a chance. A Yes at 60¢
          means the market puts the odds near 60%. Prices marked{" "}
          <span className="num">~</span> are estimates until trading opens a
          two-sided book.
        </p>
      </section>

      {/* ───────────────────────── HOW IT WORKS ─────────────────────────
          Three calm, plain-language steps. No eyebrow, no 01/02/03 markers. */}
      <section className="page" style={{ paddingTop: 56, maxWidth: 920 }}>
        <h2
          style={{
            margin: "0 0 24px",
            fontSize: 22,
            letterSpacing: "-0.01em",
          }}
        >
          How it works
        </h2>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          <Step
            title="Pick a market"
            body="Choose one of seven big stocks and a closing price you have a view on."
          />
          <Step
            title="Buy Yes or No"
            body="Yes wins if it closes at or above that price. No wins if it closes below. You pay the price up front."
          />
          <Step
            title="Get paid at the close"
            body="At 4:00 PM ET the closing price decides it. Every winning share pays out exactly $1."
          />
        </div>
      </section>

      {/* ───────────────────────── REASSURANCE ─────────────────────────
          A short, calm "why trust this" block — plain language, no jargon. */}
      <section className="page" style={{ paddingTop: 48, maxWidth: 760 }}>
        <Card padding={28}>
          <h3 style={{ margin: "0 0 16px", fontSize: 17 }}>
            Simple by design
          </h3>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 14,
            }}
          >
            {(
              [
                [
                  "You hold your own funds",
                  "Trades run from your Solana wallet. Meridian never takes custody of your money.",
                ],
                [
                  "No margin, no surprises",
                  "You pay a price between $0 and $1. That price is the most you can lose.",
                ],
                [
                  "Settled by a trusted price",
                  "Pyth publishes the official close on-chain. Winners redeem $1 a share, automatically.",
                ],
              ] as [string, string][]
            ).map(([t, d]) => (
              <li
                key={t}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 12,
                  alignItems: "start",
                }}
              >
                <IconCheck
                  size={15}
                  style={{ color: "var(--up)", marginTop: 3 }}
                />
                <div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 500,
                      color: "var(--text)",
                    }}
                  >
                    {t}
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      color: "var(--text-3)",
                      lineHeight: 1.5,
                      marginTop: 2,
                    }}
                  >
                    {d}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div style={{ marginTop: 24 }}>
            <Link
              href="/markets"
              className="btn primary"
              style={{ textDecoration: "none" }}
            >
              Browse markets <IconCaret size={11} />
            </Link>
          </div>
        </Card>
      </section>

      {/* ───────────────────────── FOOTER ───────────────────────── */}
      <footer
        className="page"
        style={{
          paddingTop: 24,
          paddingBottom: 32,
          borderTop: "1px solid var(--line-soft)",
          marginTop: 48,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 12,
            color: "var(--text-4)",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <CaretMark size={16} />
            <span>meridian — non-custodial binary options on Solana</span>
          </div>
          <div style={{ display: "flex", gap: 22, fontFamily: "var(--mono)" }}>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href="https://pyth.network" target="_blank" rel="noopener noreferrer">
              Pyth
            </a>
            <a
              href="https://explorer.solana.com/address/DQgnoMXTD6Ebo7cgie6hpNjnVCtTnLVfjPcFc4JQZS19?cluster=devnet"
              target="_blank"
              rel="noopener noreferrer"
            >
              Program
            </a>
            <span>Docs</span>
            <span>v0.1.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small hero trust chips + separator dot
// ---------------------------------------------------------------------------
function Trust({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <IconCheck size={12} style={{ color: "var(--up)" }} />
      {children}
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden style={{ color: "var(--text-4)" }}>
      ·
    </span>
  );
}

// ---------------------------------------------------------------------------
// Markets list row — one ATM market per ticker, scannable and clickable.
// Reads REAL data per ticker; renders "—" while null, marks estimates.
// ---------------------------------------------------------------------------
function MarketRow({ ticker, first }: { ticker: Ticker; first: boolean }) {
  const { strikeCents, strikeDisplay, spotDollars, yes, estimated, loading } =
    useFeatured(ticker);
  const no = yes != null ? 100 - yes : null;
  const mark = estimated ? "~" : "";
  const href =
    strikeCents != null ? `/trade/${ticker}/${strikeCents}` : `/trade/${ticker}`;

  return (
    <Link
      href={href}
      className="row-hover"
      aria-label={`Trade ${ticker} ${strikeDisplay} market`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 1.4fr) minmax(90px, 1fr) auto",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        borderTop: first ? "none" : "1px solid var(--line-soft)",
        textDecoration: "none",
        color: "var(--text)",
      }}
    >
      {/* Stock + question */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600 }}>{ticker}</span>
          <span
            style={{
              fontSize: 12.5,
              color: "var(--text-3)",
              whiteSpace: "nowrap",
            }}
          >
            close ≥ <span className="num">{strikeDisplay}</span>
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-4)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {TICKER_NAME[ticker]}
        </div>
      </div>

      {/* Spot */}
      <div style={{ textAlign: "right" }}>
        <div className="num" style={{ fontSize: 14, color: "var(--text-2)" }}>
          {spotDollars != null ? fmt$(spotDollars) : loading ? "…" : "—"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-4)" }}>now</div>
      </div>

      {/* Yes / No pills */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PricePill label="Yes" cents={yes} mark={mark} tone="up" />
        <PricePill label="No" cents={no} mark={mark} tone="dn" />
        <IconCaret
          size={12}
          aria-hidden
          style={{ color: "var(--text-4)", flexShrink: 0 }}
        />
      </div>
    </Link>
  );
}

function PricePill({
  label,
  cents,
  mark,
  tone,
}: {
  label: string;
  cents: number | null;
  mark: string;
  tone: "up" | "dn";
}) {
  const color = tone === "up" ? "var(--up)" : "var(--down)";
  const bg = tone === "up" ? "var(--up-soft)" : "var(--down-soft)";
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        minWidth: 52,
        padding: "6px 10px",
        borderRadius: 8,
        background: bg,
      }}
    >
      <span
        style={{
          fontSize: 10,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color,
        }}
      >
        {label}
      </span>
      <span
        className="num"
        style={{ fontSize: 14, fontWeight: 600, color, lineHeight: 1.2 }}
      >
        {cents != null ? `${mark}${cents}¢` : "—"}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// How-it-works step card
// ---------------------------------------------------------------------------
function Step({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        padding: 22,
        borderRadius: "var(--r)",
        background: "var(--bg-elev)",
        border: "1px solid var(--line-soft)",
      }}
    >
      <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{title}</h3>
      <p
        style={{
          margin: 0,
          fontSize: 13.5,
          color: "var(--text-3)",
          lineHeight: 1.55,
        }}
      >
        {body}
      </p>
    </div>
  );
}

/** Format a cents price (1..99) as a dollar string, e.g. 60 → "$0.60". */
function fmtPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
