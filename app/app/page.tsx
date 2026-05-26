"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import {
  Button,
  CaretMark,
  Card,
  Label,
  Pill,
  ProbBar,
  IconBolt,
  IconCaret,
  IconCheck,
  IconPyth,
  IconRight,
  IconWallet,
  fmt$,
} from "@/components/caret";
import { MarketStatusChip } from "@/components/MarketStatusChip";
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
} {
  const { rows } = useStrikeList(ticker);
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
  };
}

/**
 * Landing — REAL on-chain data only.
 *
 *   - Headline + featured cards read the live ATM strike / yes price from
 *     `useStrikeList` and the oracle spot from `useSpotPrice`.
 *   - Ticker tape reads real oracle spot per ticker (no synthesized change).
 */
export default function LandingPage() {
  const mounted = useMounted();
  const wallet = useWallet();
  const walletModal = useWalletModal();
  const connected = mounted && wallet.connected;

  const featured = useFeatured("AAPL");
  const sideCard = useFeatured("MSFT");

  function connectOrGo() {
    if (!connected) walletModal.setVisible(true);
  }

  return (
    <div>
      {/* HERO */}
      <section className="accent-glow" style={{ padding: "80px 0 60px" }}>
        <div className="page" style={{ paddingBottom: 0 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr",
              gap: 80,
              alignItems: "center",
            }}
          >
            <div>
              <Pill tone="accent" style={{ marginBottom: 28 }}>
                <span
                  className="dot"
                  style={{
                    background: "var(--accent)",
                    boxShadow: "0 0 8px var(--accent)",
                  }}
                />
                MAG7 · 0DTE · Pyth-settled · Solana
              </Pill>

              <h1 style={{ marginBottom: 22, color: "var(--text)" }}>
                Will{" "}
                <span style={{ color: "var(--accent)" }}>{featured.ticker}</span>{" "}
                close above{" "}
                <span
                  className="num"
                  style={{ color: "var(--text-2)", fontFeatureSettings: '"ss01"' }}
                >
                  {featured.strikeDisplay}
                </span>{" "}
                today?
              </h1>

              <p
                style={{
                  fontSize: 19,
                  lineHeight: 1.5,
                  color: "var(--text-2)",
                  maxWidth: 560,
                  marginBottom: 14,
                }}
              >
                Trade Yes/No tokens on whether MAG7 stocks close above today&apos;s
                strike. One question, one day, one outcome. Settled at the bell by
                Pyth.
              </p>
              <p
                style={{
                  fontSize: 14,
                  color: "var(--text-3)",
                  maxWidth: 560,
                  marginBottom: 32,
                }}
              >
                Yes + No = $1.00 USDC. Always. Non-custodial. No margin. No Greeks.
              </p>

              <div style={{ display: "flex", gap: 10 }}>
                {connected ? (
                  <Link
                    href="/markets"
                    className="btn primary lg"
                    style={{ textDecoration: "none" }}
                  >
                    Go to Markets
                    <IconCaret size={12} />
                  </Link>
                ) : (
                  <Button primary lg onClick={connectOrGo}>
                    Connect wallet
                    <IconCaret size={12} />
                  </Button>
                )}
                <Link
                  href="/markets"
                  className="btn lg"
                  style={{ textDecoration: "none" }}
                >
                  Browse markets
                </Link>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 24,
                  marginTop: 36,
                  fontSize: 12,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <IconBolt size={12} style={{ color: "var(--accent)" }} /> 400ms
                  blocks
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <IconCheck size={12} style={{ color: "var(--up)" }} /> On-chain CLOB
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <IconPyth size={12} style={{ color: "var(--accent)" }} /> Pyth-settled
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <IconWallet size={12} /> Self-custody
                </span>
              </div>
            </div>

            <FeaturedContract
              ticker={sideCard.ticker}
              strikeCents={sideCard.strikeCents}
              strikeDisplay={sideCard.strikeDisplay}
              yes={sideCard.yes}
              spotDollars={sideCard.spotDollars}
            />
          </div>
        </div>
      </section>

      {/* TICKER */}
      <TickerTape />

      {/* HOW IT WORKS */}
      <section className="page">
        <div style={{ marginBottom: 32 }}>
          <Label>How it works</Label>
          <h2 style={{ marginTop: 8 }}>One question. One day. One outcome.</h2>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 1,
            background: "var(--line-soft)",
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid var(--line-soft)",
          }}
        >
          {[
            {
              n: "01",
              t: "Pick a strike",
              d: "Each MAG7 ticker has up to 7 strikes daily (±3/6/9% around yesterday's close). Pick the one that matches your view.",
              k: ["8:00 AM ET", "strike chain auto-built"],
            },
            {
              n: "02",
              t: "Trade Yes / No",
              d: "Yes pays $1 if the stock closes at-or-above. No pays $1 if it doesn't. One book, two perspectives.",
              k: ["Market or limit", "On-chain CLOB"],
            },
            {
              n: "03",
              t: "Settle at 4 PM ET",
              d: "Pyth publishes the close. Smart contract settles. Winners redeem $1.00 per token, on-chain.",
              k: ["~4:05 PM ET", "Atomic redeem"],
            },
          ].map((c) => (
            <div key={c.n} style={{ background: "var(--bg-elev)", padding: 28 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: 32,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--accent)",
                    letterSpacing: "0.08em",
                  }}
                >
                  {c.n}
                </span>
                <IconRight size={14} style={{ color: "var(--text-3)" }} />
              </div>
              <h3 style={{ marginBottom: 10 }}>{c.t}</h3>
              <p
                style={{
                  fontSize: 13.5,
                  color: "var(--text-2)",
                  lineHeight: 1.6,
                  marginBottom: 18,
                }}
              >
                {c.d}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text-3)",
                }}
              >
                {c.k.map((kk, i) => (
                  <span key={i}>
                    {i > 0 && (
                      <span style={{ marginRight: 12, color: "var(--text-4)" }}>
                        ·
                      </span>
                    )}
                    {kk}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING RELATIONSHIP */}
      <section className="page" style={{ paddingTop: 0 }}>
        <Card
          padding={36}
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56 }}
        >
          <div>
            <Label>The math</Label>
            <h2 style={{ marginTop: 8, marginBottom: 18 }}>
              Yes + No = $1.00.
              <br />
              Always.
            </h2>
            <p
              style={{
                fontSize: 14,
                color: "var(--text-2)",
                lineHeight: 1.6,
                marginBottom: 16,
              }}
            >
              Each Yes token is a digital cash-or-nothing call on AAPL, MSFT,
              GOOGL, AMZN, NVDA, META, TSLA — strike K, expiry today&apos;s close.
            </p>
            <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
              The Yes price approximates the market-implied probability that
              S<sub>T</sub> ≥ K.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 16,
            }}
          >
            <PayoffMini strikeDisplay={featured.strikeDisplay} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div
                style={{
                  padding: 14,
                  background: "var(--up-soft)",
                  borderRadius: 8,
                  border: "1px solid var(--up-line)",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    letterSpacing: "0.08em",
                    color: "var(--up)",
                    textTransform: "uppercase",
                    marginBottom: 4,
                  }}
                >
                  YES @ {featured.yes != null ? `${featured.yes}¢` : "—"}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-2)" }}>
                  You pay{" "}
                  {featured.yes != null ? `$${(featured.yes / 100).toFixed(2)}` : "—"} → wins
                  $1.00 if {featured.ticker} closes ≥ {featured.strikeDisplay}
                </div>
              </div>
              <div
                style={{
                  padding: 14,
                  background: "var(--down-soft)",
                  borderRadius: 8,
                  border: "1px solid var(--down-line)",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    letterSpacing: "0.08em",
                    color: "var(--down)",
                    textTransform: "uppercase",
                    marginBottom: 4,
                  }}
                >
                  NO @ {featured.yes != null ? `${100 - featured.yes}¢` : "—"}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-2)" }}>
                  You pay{" "}
                  {featured.yes != null
                    ? `$${((100 - featured.yes) / 100).toFixed(2)}`
                    : "—"}{" "}
                  → wins $1.00 if {featured.ticker} closes &lt; {featured.strikeDisplay}
                </div>
              </div>
            </div>
          </div>
        </Card>
      </section>

      {/* WHAT YOU GET */}
      <section className="page" style={{ paddingTop: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 24 }}>
          <Card padding={28}>
            <Label>What you get</Label>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "18px 0 0",
                display: "grid",
                gap: 14,
              }}
            >
              {([
                ["Non-custodial", "Your keys, your tokens. Meridian never holds your USDC."],
                ["Sub-second CLOB", "In-program order book on Solana — limit/market orders match in the same transaction, ~400ms block time."],
                ["Pyth-settled", "Same publisher set as Jane Street + Jump. Confidence-checked."],
                ["Atomic Buy-No", "Mint pair + sell Yes in one wallet click. No two-step UX."],
                ["Same-day expiry", "Maximum loss is your entry price. No Greeks, no margin calls."],
              ] as [string, string][]).map(([t, d]) => (
                <li
                  key={t}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: 12,
                    alignItems: "baseline",
                  }}
                >
                  <IconCheck size={13} style={{ color: "var(--up)" }} />
                  <div>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "var(--text)",
                      }}
                    >
                      {t}
                    </span>
                    <span style={{ fontSize: 13, color: "var(--text-3)" }}>
                      {" "}
                      — {d}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            padding={28}
            style={{
              background:
                "linear-gradient(135deg, var(--accent-soft) 0%, transparent 70%)",
            }}
          >
            <Label>Live demo · Devnet</Label>
            <h3 style={{ margin: "12px 0 12px" }}>
              Try it without putting anything at risk.
            </h3>
            <p
              style={{
                fontSize: 13.5,
                color: "var(--text-2)",
                lineHeight: 1.6,
                marginBottom: 18,
              }}
            >
              Connect a Solana wallet on devnet. Use the in-app USDC faucet, or
              hit the local validator with{" "}
              <code
                style={{
                  fontFamily: "var(--mono)",
                  padding: "1px 5px",
                  background: "var(--bg-elev-2)",
                  borderRadius: 4,
                }}
              >
                make airdrop
              </code>
              .
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link href="/markets" className="btn primary" style={{ textDecoration: "none" }}>
                Browse live markets <IconCaret size={11} />
              </Link>
              {!connected && (
                <Button onClick={connectOrGo}>Get devnet USDC</Button>
              )}
            </div>
          </Card>
        </div>
      </section>

      {/* FOOTER */}
      <footer
        className="page"
        style={{
          paddingTop: 24,
          paddingBottom: 32,
          borderTop: "1px solid var(--line-soft)",
          marginTop: 24,
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
// Featured contract side-card
// ---------------------------------------------------------------------------
function FeaturedContract({
  ticker,
  strikeCents,
  strikeDisplay,
  yes,
  spotDollars,
}: {
  ticker: Ticker;
  strikeCents: number | null;
  strikeDisplay: string;
  yes: number | null;
  spotDollars: number | null;
}) {
  const no = yes != null ? 100 - yes : null;
  const href = strikeCents != null ? `/trade/${ticker}/${strikeCents}` : `/trade/${ticker}`;
  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          position: "absolute",
          inset: -12,
          background:
            "radial-gradient(60% 50% at 50% 50%, var(--accent-soft), transparent 70%)",
          filter: "blur(40px)",
          zIndex: 0,
        }}
      />
      <Card padding={24} style={{ position: "relative", background: "var(--bg-elev)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="label">Featured</span>
            <MarketStatusChip />
          </div>
          <span
            style={{
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--text-3)",
            }}
          >
            settles 4:00 PM ET
          </span>
        </div>

        <Link
          href={href}
          style={{ display: "block", marginBottom: 18, textDecoration: "none" }}
        >
          <h3 style={{ fontSize: 28, letterSpacing: "-0.02em", marginBottom: 4 }}>
            {ticker}{" "}
            <IconCaret
              size={15}
              style={{
                verticalAlign: "middle",
                color: "var(--accent)",
                margin: "0 2px",
              }}
            />{" "}
            <span className="num">{strikeDisplay}</span>
          </h3>
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>
            {TICKER_NAME[ticker]} · spot {spotDollars != null ? fmt$(spotDollars) : "—"} ·
            settles 4:00 PM ET
          </span>
        </Link>

        <ProbBar yes={yes ?? 50} h={8} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginTop: 18,
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              background: "var(--up-soft)",
              border: "1px solid var(--up-line)",
            }}
          >
            <div className="label" style={{ color: "var(--up)" }}>
              YES
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginTop: 4,
              }}
            >
              <span
                className="num"
                style={{ fontSize: 22, fontWeight: 600, color: "var(--up)" }}
              >
                {yes != null ? `${yes}¢` : "—"}
              </span>
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--text-3)" }}
              >
                {yes != null ? `= ${yes}%` : ""}
              </span>
            </div>
          </div>
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              background: "var(--down-soft)",
              border: "1px solid var(--down-line)",
            }}
          >
            <div className="label" style={{ color: "var(--down)" }}>
              NO
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginTop: 4,
              }}
            >
              <span
                className="num"
                style={{ fontSize: 22, fontWeight: 600, color: "var(--down)" }}
              >
                {no != null ? `${no}¢` : "—"}
              </span>
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--text-3)" }}
              >
                {no != null ? `= ${no}%` : ""}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ticker tape — REAL oracle spot per MAG7 ticker (no synthesized change).
// ---------------------------------------------------------------------------
function TickerTape() {
  // Two passes for the seamless marquee. Spot read live inside each item.
  return (
    <div className="ticker-wrap" style={{ background: "var(--bg-elev)" }}>
      <div className="ticker">
        {[0, 1].map((pass) =>
          MAG7_TICKERS.map((t) => (
            <TickerTapeItem key={`${pass}-${t}`} ticker={t} />
          )),
        )}
      </div>
    </div>
  );
}

function TickerTapeItem({ ticker }: { ticker: Ticker }) {
  const { spotUsd } = useSpotPrice(ticker);
  return (
    <span className="t">
      <span className="sym">{ticker}</span>
      <span className="muted">{TICKER_NAME[ticker]}</span>
      <span>{spotUsd != null ? fmt$(spotUsd) : "—"}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Payoff mini SVG
// ---------------------------------------------------------------------------
function PayoffMini({ strikeDisplay }: { strikeDisplay: string }) {
  return (
    <svg viewBox="0 0 400 180" style={{ width: "100%", height: 180 }}>
      <line x1="40" y1="20" x2="40" y2="155" stroke="var(--line)" />
      <line x1="40" y1="155" x2="385" y2="155" stroke="var(--line)" />
      <line
        x1="210"
        y1="20"
        x2="210"
        y2="158"
        stroke="var(--accent)"
        strokeDasharray="3 3"
        strokeWidth="1"
        opacity="0.7"
      />
      <text x="210" y="14" textAnchor="middle" fill="var(--accent)" fontSize="10" fontFamily="var(--mono)">
        K = {strikeDisplay}
      </text>
      <path d="M40,130 L210,130 L210,40 L385,40" fill="none" stroke="var(--up)" strokeWidth="2" />
      <text x="380" y="34" textAnchor="end" fill="var(--up)" fontSize="10" fontFamily="var(--mono)">
        YES pays $1
      </text>
      <path
        d="M40,40 L210,40 L210,130 L385,130"
        fill="none"
        stroke="var(--down)"
        strokeWidth="2"
        strokeDasharray="4 3"
        opacity="0.7"
      />
      <text x="50" y="34" fill="var(--down)" fontSize="10" fontFamily="var(--mono)">
        NO pays $1
      </text>
      <text x="40" y="170" fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">
        −9%
      </text>
      <text x="210" y="170" textAnchor="middle" fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">
        close
      </text>
      <text x="380" y="170" textAnchor="end" fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">
        +9%
      </text>
      <text x="32" y="42" textAnchor="end" fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">
        $1
      </text>
      <text x="32" y="135" textAnchor="end" fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">
        $0
      </text>
    </svg>
  );
}
