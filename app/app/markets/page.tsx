"use client";

// Markets browse page — per-ticker groups (Browse) or compact rows over REAL
// on-chain markets. Lists the MAG7 plus any distinct "-T" TEST fixtures found
// on-chain (sorted last, labeled with a .test-badge pill so they read as fake).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  IconClock,
  IconRight,
  IconSearch,
  Seg,
  fmt$,
} from "@/components/caret";
import { MarketStatusChip } from "@/components/MarketStatusChip";
import {
  useAllMarkets,
  useResolvedStrikeList,
  useSpotPrice,
  useStrikeList,
  type StrikeRow,
} from "@/lib/markets-client";
import { pickRedirectStrike } from "@/lib/trade-redirect";
import { useMounted } from "@/lib/use-mounted";
import {
  MAG7_TICKERS,
  TICKER_NAME,
  displayTickerName,
  isTestTicker,
  type Ticker,
} from "@/lib/tickers";

/** Closest strike to a real spot (cents); null when either is unavailable. */
function atmFromRows(rows: StrikeRow[], spotCents: number | null): number | null {
  if (rows.length === 0 || spotCents == null) return null;
  let best = rows[0]!.strike;
  let bestDist = Math.abs(spotCents - best);
  for (const r of rows) {
    const d = Math.abs(spotCents - r.strike);
    if (d < bestDist) {
      best = r.strike;
      bestDist = d;
    }
  }
  return best;
}

type View = "cards" | "list";

/**
 * Markets — REAL on-chain data only.
 *
 * Markets come from `useAllMarkets()`; per-ticker spot from `useSpotPrice()`
 * (on-chain OracleAccount) and strike chains from `useStrikeList()` (derived
 * from real markets + real order-book mids). No mock spot / change / strikes.
 *
 * Approachable-retail browse: one calm default (per-ticker groups, each a
 * legible Yes/No strike ladder), with a Compact list as the alternate view.
 */
export default function MarketsPage() {
  const [view, setView] = useState<View>("cards");
  const [search, setSearch] = useState("");
  const mounted = useMounted();

  const { markets } = useAllMarkets();

  // Static per-stock metadata (no synthesized prices). Spot + strikes are read
  // live inside each group via real hooks. The visible list is the MAG7 plus
  // any DISTINCT "-T" TEST fixtures observed on-chain (e.g. "AAPL-T"), which
  // sort last and carry an explicit TEST badge.
  const stocks = useMemo<StockRow[]>(() => {
    const real: StockRow[] = MAG7_TICKERS.map((t) => ({
      sym: t,
      name: TICKER_NAME[t],
      isTest: false,
    }));
    const testSyms = [
      ...new Set(markets.map((m) => m.ticker as string).filter(isTestTicker)),
    ].sort();
    const test: StockRow[] = testSyms.map((t) => ({
      // Route/hook plumbing types tickers as the MAG7 union; test tickers are
      // real on-chain strings outside it, so cast at this one seam.
      sym: t as Ticker,
      name: displayTickerName(t),
      isTest: true,
    }));
    return [...real, ...test];
  }, [markets]);

  const filtered = stocks.filter((s) => {
    if (
      search &&
      !s.sym.toLowerCase().includes(search.toLowerCase()) &&
      !s.name.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    return true;
  });

  // Real tickers alphabetical first; TEST fixtures always last.
  const sorted = [...filtered].sort((a, b) =>
    a.isTest !== b.isTest ? (a.isTest ? 1 : -1) : a.sym.localeCompare(b.sym),
  );

  const activeStrikes = markets.filter((m) => !m.settled).length;
  const todayLabel = mounted
    ? new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";

  return (
    <div className="page" style={{ position: "relative", isolation: "isolate" }}>
      {/* Decorative aurora — a more pronounced variant than the landing's.
          `isolation:isolate` on the page makes the z-index:-1 aura sit above
          the body background but behind the content, no per-child stacking. */}
      <div className="hero-aura strong" aria-hidden>
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
      </div>
      {/* ───────────────────────── HEADER ─────────────────────────
          Plain, calm intro: one title, one supporting line, the live
          market-status chip. No uppercase eyebrow, no dense metadata. */}
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div>
          <h2 style={{ marginBottom: 8 }}>Today&apos;s markets</h2>
          <p style={{ fontSize: 14, color: "var(--text-3)", maxWidth: 520, lineHeight: 1.5 }}>
            Pick a price for one of the 7 biggest tech stocks, then bet Yes or No
            on where it closes. Every market settles today at 4:00 PM ET.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <MarketStatusChip />
          {mounted && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12.5,
                color: "var(--text-3)",
              }}
            >
              <IconClock size={12} />
              {todayLabel}
            </span>
          )}
        </div>
      </header>

      {/* ───────────────────────── TOOLBAR ─────────────────────────
          Search + a two-option view switch. Quiet, generous, wraps on
          mobile instead of overflowing. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 420 }}>
          <IconSearch
            size={14}
            style={{
              position: "absolute",
              left: 13,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-3)",
              pointerEvents: "none",
            }}
          />
          <input
            className="field"
            placeholder="Search a stock (Apple, NVDA…)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search markets by stock name or ticker"
            style={{ paddingLeft: 38, height: 40 }}
          />
        </div>

        <div style={{ flex: 1 }} />

        <Seg
          options={[
            { value: "cards" as View, label: "Browse" },
            { value: "list" as View, label: "Compact" },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      {/* ───────────────────────── CONTENT ───────────────────────── */}
      {sorted.length === 0 ? (
        <div
          style={{
            padding: "64px 24px",
            textAlign: "center",
            color: "var(--text-3)",
            fontSize: 14,
            border: "1px dashed var(--line-soft)",
            borderRadius: "var(--r-lg)",
          }}
        >
          No stocks match &ldquo;{search}&rdquo;.
        </div>
      ) : view === "cards" ? (
        <div className="stack" style={{ gap: 16 }}>
          {sorted.map((s) => (
            <StockGroup key={s.sym} stock={s} />
          ))}
        </div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {sorted.map((s) => (
            <CompactRow key={s.sym} stock={s} />
          ))}
        </div>
      )}

      {activeStrikes > 0 && (
        <p
          style={{
            marginTop: 28,
            fontSize: 12.5,
            color: "var(--text-4)",
            textAlign: "center",
          }}
        >
          {activeStrikes} price{activeStrikes === 1 ? "" : "s"} open across{" "}
          {stocks.length} stocks · all settle at 4:00 PM ET
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared per-ticker data hook — keeps the same real reads the page always used.
// ---------------------------------------------------------------------------
interface StockRow {
  sym: Ticker;
  name: string;
  /** True for a "-T" TEST fixture — rendered with an explicit TEST badge. */
  isTest: boolean;
}

function useStockData(sym: Ticker) {
  const { rows: activeChain, loading: chainLoading } = useStrikeList(sym);
  const { rows: settledChain } = useResolvedStrikeList(sym);
  const { spotUsd } = useSpotPrice(sym);
  const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;
  // After the close the active chain is empty; fall back to settled (read-only)
  // strikes so the group still shows resolved outcomes instead of only spot.
  const resolvedView = activeChain.length === 0 && settledChain.length > 0;
  const chain = resolvedView ? settledChain : activeChain;
  const atm = atmFromRows(chain, spotCents);
  // Real volume = sum of observed OrderMatched fills across this ticker's
  // strikes (settled rows carry no live volume).
  const totalVol = chain.reduce((sum, c) => sum + c.volume, 0);
  // Link to a REAL strike: ATM active → ATM settled → /markets, via the shared
  // helper the redirect page uses so they never disagree.
  const redirectTarget = pickRedirectStrike(
    activeChain.map((c) => c.strike),
    settledChain.map((c) => c.strike),
    spotCents,
  );
  const href =
    redirectTarget != null ? `/trade/${sym}/${redirectTarget}` : "/markets";

  return {
    spotUsd,
    chain,
    chainLoading,
    resolvedView,
    atm,
    totalVol,
    href,
  };
}

// ---------------------------------------------------------------------------
// Stock group (default "Browse" view) — a ticker header over a legible
// Yes/No/Volume strike ladder. Each ladder row is an obvious click into trade.
// ---------------------------------------------------------------------------
function StockGroup({ stock }: { stock: StockRow }) {
  const router = useRouter();
  const { spotUsd, chain, chainLoading, resolvedView, atm, totalVol, href } =
    useStockData(stock.sym);

  // Show a focused window of the ladder around the at-the-money price so the
  // group stays scannable; expand reveals the full chain.
  const [expanded, setExpanded] = useState(false);
  const ladder = useMemo(() => orderForLadder(chain, atm), [chain, atm]);
  const visible = expanded ? ladder : windowAroundAtm(ladder, atm, 5);
  const hiddenCount = ladder.length - visible.length;

  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Group header — ticker, plain name, live spot. Clickable into the
          at-the-money market (keyboard-accessible). */}
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open ${stock.name} at the closest price to spot`}
        onClick={() => router.push(href)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            router.push(href);
          }
        }}
        className="row-hover"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "16px 18px",
          cursor: "pointer",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {stock.sym}
          </span>
          {stock.isTest && <span className="test-badge">Test market</span>}
          <span
            style={{
              fontSize: 13.5,
              color: "var(--text-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {stock.name}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ textAlign: "right" }}>
            <div className="num" style={{ fontSize: 18, fontWeight: 500 }}>
              {spotUsd != null ? fmt$(spotUsd) : "—"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)" }}>
              {resolvedView ? "closing price" : "trading now"}
            </div>
          </div>
          <IconRight size={16} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        </div>
      </div>

      {/* Ladder header — plain language: Price, Yes, No, Activity. */}
      {chain.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr 1fr 1fr",
            padding: "8px 18px",
            borderTop: "1px solid var(--line-soft)",
            background: "var(--bg-elev-2)",
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-3)",
          }}
        >
          <span>Closes at or above</span>
          <span style={{ textAlign: "right" }}>Yes</span>
          <span style={{ textAlign: "right" }}>No</span>
          <span style={{ textAlign: "right" }}>
            {resolvedView ? "Result" : "Activity"}
          </span>
        </div>
      )}

      {/* Ladder body */}
      {chain.length === 0 ? (
        <div
          style={{
            padding: "28px 18px",
            textAlign: "center",
            color: "var(--text-3)",
            fontSize: 13,
            borderTop: "1px solid var(--line-soft)",
          }}
        >
          {chainLoading ? "Loading prices…" : "No prices open right now."}
        </div>
      ) : (
        <div>
          {visible.map((c) => (
            <LadderRow
              key={c.strike}
              ticker={stock.sym}
              row={c}
              isAtm={c.strike === atm}
              resolvedView={resolvedView}
            />
          ))}
        </div>
      )}

      {/* Footer — expand control + honest summary. */}
      {chain.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 18px",
            borderTop: "1px solid var(--line-soft)",
            flexWrap: "wrap",
          }}
        >
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="btn sm ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show fewer prices" : `Show all ${ladder.length} prices`}
            </button>
          ) : (
            <span />
          )}
          <span style={{ fontSize: 12, color: "var(--text-4)" }}>
            {totalVol > 0
              ? `${totalVol.toLocaleString()} shares traded today`
              : resolvedView
                ? "settled · 4:00 PM ET"
                : "no trades yet today"}
          </span>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A single ladder row — strike (as "closes at or above $X"), Yes / No prices
// in plain "chance" terms, and either live activity or the settled result.
// ---------------------------------------------------------------------------
function LadderRow({
  ticker,
  row,
  isAtm,
  resolvedView,
}: {
  ticker: Ticker;
  row: StrikeRow;
  isAtm: boolean;
  resolvedView: boolean;
}) {
  const resolved = row.status === "resolved" && row.outcome != null;
  const awaiting = row.status === "expired";
  const strikeUsd = row.strike / 100;

  return (
    <Link
      href={`/trade/${ticker}/${row.strike}`}
      className="row-hover"
      aria-label={`${ticker} closes at or above $${strikeUsd.toFixed(0)} — open this market`}
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr 1fr 1fr",
        alignItems: "center",
        padding: "11px 18px",
        borderTop: "1px solid var(--line-soft)",
        textDecoration: "none",
        color: "var(--text)",
        background: isAtm ? "var(--accent-soft)" : "transparent",
      }}
    >
      {/* Price (the strike). The at-the-money row gets a quiet "near spot" cue
          instead of the jargon "ATM". */}
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="num" style={{ fontSize: 15, fontWeight: isAtm ? 600 : 500 }}>
          ${strikeUsd.toFixed(0)}
        </span>
        {isAtm && (
          <span
            style={{
              fontSize: 10.5,
              color: "var(--accent)",
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            near spot
          </span>
        )}
      </span>

      {resolved ? (
        // Settled: show which side won across both price cells, frozen.
        <>
          <span style={{ textAlign: "right" }}>
            <Outcome win={row.outcome === "yes"} label="Yes" />
          </span>
          <span style={{ textAlign: "right" }}>
            <Outcome win={row.outcome === "no"} label="No" />
          </span>
          <span
            style={{
              textAlign: "right",
              fontSize: 12,
              color: "var(--text-3)",
            }}
          >
            settled
          </span>
        </>
      ) : awaiting ? (
        <>
          <span style={{ textAlign: "right", color: "var(--text-3)", fontSize: 13 }}>
            —
          </span>
          <span style={{ textAlign: "right", color: "var(--text-3)", fontSize: 13 }}>
            —
          </span>
          <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>
            settling…
          </span>
        </>
      ) : (
        <>
          <ChanceCell cents={row.yesCents} tone="up" estimated={row.estimated} />
          <ChanceCell cents={row.noCents} tone="down" estimated={row.estimated} />
          <span
            style={{
              textAlign: "right",
              fontSize: 12.5,
              fontFamily: "var(--mono)",
              color: "var(--text-3)",
            }}
          >
            {row.volume > 0 ? row.volume.toLocaleString() : "—"}
          </span>
        </>
      )}
    </Link>
  );
}

/** A live Yes/No price shown as a plain "chance" (cent == percent). The "~"
 *  marks an estimate when there's no resting book. */
function ChanceCell({
  cents,
  tone,
  estimated,
}: {
  cents: number;
  tone: "up" | "down";
  estimated: boolean;
}) {
  return (
    <span
      style={{
        textAlign: "right",
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-end",
        lineHeight: 1.2,
      }}
    >
      <span
        className="num"
        style={{ fontSize: 15, fontWeight: 600, color: `var(--${tone})` }}
      >
        {estimated ? "~" : ""}
        {cents}¢
      </span>
      <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>
        {estimated ? "est. chance" : `${cents}% chance`}
      </span>
    </span>
  );
}

/** A settled outcome chip — winning side in color, losing side muted. */
function Outcome({ win, label }: { win: boolean; label: string }) {
  return (
    <span
      className="num"
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: win ? `var(--${label === "Yes" ? "up" : "down"})` : "var(--text-4)",
      }}
    >
      {win ? `${label} won` : label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Compact list row — one line per stock for fast scanning: ticker, spot, and
// the Yes price for the at-the-money market with a chance bar. Whole row clicks
// into trade.
// ---------------------------------------------------------------------------
function CompactRow({ stock }: { stock: StockRow }) {
  const { spotUsd, chain, resolvedView, atm, totalVol, href } = useStockData(
    stock.sym,
  );
  const atmRow = chain.find((c) => c.strike === atm) ?? null;
  const yes = atmRow?.yesCents ?? null;

  return (
    <Link
      href={href}
      className="card row-hover"
      aria-label={`${stock.name} — open the market closest to spot`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1.4fr) auto minmax(120px,1.2fr)",
        alignItems: "center",
        gap: 16,
        padding: "14px 18px",
        textDecoration: "none",
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{stock.sym}</span>
        {stock.isTest && <span className="test-badge">Test market</span>}
        <span
          style={{
            fontSize: 13,
            color: "var(--text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {stock.name}
        </span>
      </div>

      <div style={{ textAlign: "right" }}>
        <div className="num" style={{ fontSize: 15, fontWeight: 500 }}>
          {spotUsd != null ? fmt$(spotUsd) : "—"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-4)" }}>
          {totalVol > 0
            ? `${totalVol.toLocaleString()} traded`
            : resolvedView
              ? "settled"
              : "no trades yet"}
        </div>
      </div>

      {/* At-the-money chance, as a quiet bar + label. Honest "—" when no book. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
        {yes != null && !resolvedView ? (
          <>
            <div
              aria-hidden
              style={{
                flex: 1,
                maxWidth: 90,
                height: 6,
                borderRadius: 999,
                background: "var(--bg-elev-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, yes))}%`,
                  height: "100%",
                  background: "var(--up)",
                  opacity: 0.85,
                }}
              />
            </div>
            <span
              className="num"
              style={{ fontSize: 14, fontWeight: 600, color: "var(--up)", minWidth: 56, textAlign: "right" }}
            >
              {atmRow?.estimated ? "~" : ""}
              {yes}% Yes
            </span>
          </>
        ) : (
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>
            {resolvedView ? "settled" : "—"}
          </span>
        )}
        <IconRight size={15} style={{ color: "var(--text-3)", flexShrink: 0 }} />
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Ladder ordering helpers (display only — no data synthesis).
// ---------------------------------------------------------------------------

/** Sort strikes high→low so the ladder reads like a price ladder. */
function orderForLadder(chain: StrikeRow[], _atm: number | null): StrikeRow[] {
  void _atm;
  return [...chain].sort((a, b) => b.strike - a.strike);
}

/** A centered window of `±half` rows around the at-the-money strike, keeping the
 *  ladder scannable. Falls back to the head of the ladder when spot is unknown. */
function windowAroundAtm(
  ladder: StrikeRow[],
  atm: number | null,
  half: number,
): StrikeRow[] {
  if (ladder.length <= half * 2 + 1) return ladder;
  let center = 0;
  if (atm != null) {
    const idx = ladder.findIndex((r) => r.strike === atm);
    if (idx >= 0) center = idx;
  }
  const start = Math.max(0, Math.min(center - half, ladder.length - (half * 2 + 1)));
  return ladder.slice(start, start + half * 2 + 1);
}
