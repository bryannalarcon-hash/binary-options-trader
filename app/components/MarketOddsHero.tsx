"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { IconCaret } from "@/components/caret";
import { fmtStockPrice } from "@/lib/format";
import {
  computeImpliedDistribution,
  type ImpliedDistributionResult,
} from "@/lib/implied-distribution";
import { useSpotPrice, useStrikeList } from "@/lib/markets-client";
import { MAG7_TICKERS, TICKER_NAME, type Ticker } from "@/lib/tickers";

/**
 * MarketOddsHero — the landing centerpiece.
 *
 * Turns the at-the-money market for a chosen MAG7 stock into one living focal
 * point: the crowd's live Yes/No split, and the full market-implied
 * distribution of where the stock closes today (Breeden-Litzenberger over the
 * real strike chain). Everything is REAL on-chain data — Yes prices from
 * `useStrikeList`, spot from the oracle via `useSpotPrice`. Nulls render as a
 * calm loading state, never an invented number.
 *
 * The viewer switches stocks with the chips up top; the odds bar and the curve
 * re-animate on each switch.
 */
export function MarketOddsHero() {
  const [ticker, setTicker] = useState<Ticker>("AAPL");
  const { rows, loading } = useStrikeList(ticker);
  const { spotUsd } = useSpotPrice(ticker);
  const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;

  // At-the-money strike = the one closest to live spot (falls back to first).
  const atm = useMemo(() => {
    if (rows.length === 0) return null;
    if (spotCents == null) return rows[0]!;
    return rows.reduce((best, r) =>
      Math.abs(r.strike - spotCents) < Math.abs(best.strike - spotCents) ? r : best,
    );
  }, [rows, spotCents]);

  const dist = useMemo(
    () => computeImpliedDistribution(rows.map((r) => ({ strike: r.strike, yes: r.yesCents }))),
    [rows],
  );

  const yes = atm?.yesCents ?? null;
  const no = yes != null ? 100 - yes : null;
  const estimated = atm?.estimated ?? false;
  const strikeCents = atm?.strike ?? null;
  const strikeLabel = strikeCents != null ? fmtStockPrice(strikeCents) : "—";
  const href =
    strikeCents != null ? `/trade/${ticker}/${strikeCents}` : `/trade/${ticker}`;
  const isLoading = loading && rows.length === 0;

  return (
    <div
      className="card edge-accent"
      style={{
        width: "100%",
        maxWidth: 760,
        marginTop: 44,
        padding: "22px 24px 24px",
        textAlign: "left",
        overflow: "hidden",
      }}
    >
      {/* Ticker switcher — the interactive "alive" affordance */}
      <div
        role="tablist"
        aria-label="Choose a stock"
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}
      >
        {MAG7_TICKERS.map((t) => {
          const on = t === ticker;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={on}
              onClick={() => setTicker(t)}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.02em",
                padding: "6px 11px",
                borderRadius: 999,
                cursor: "pointer",
                transition: "background .14s, color .14s, border-color .14s",
                color: on ? "var(--accent-ink)" : "var(--text-2)",
                background: on ? "var(--accent)" : "var(--bg-elev-2)",
                border: `1px solid ${on ? "var(--accent)" : "var(--line-soft)"}`,
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {/* Headline question */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2
          style={{
            margin: 0,
            fontSize: 21,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            color: "var(--text)",
            lineHeight: 1.3,
          }}
        >
          Will {ticker} close at or above <span className="num">{strikeLabel}</span> today?
        </h2>
        <span style={{ fontSize: 12.5, color: "var(--text-3)", whiteSpace: "nowrap" }}>
          {TICKER_NAME[ticker]} · now{" "}
          <span className="num" style={{ color: "var(--text-2)" }}>
            {spotUsd != null ? fmtStockPrice(Math.round(spotUsd * 100)) : isLoading ? "…" : "—"}
          </span>
        </span>
      </div>

      {/* The crowd's live answer — an animated Yes/No split */}
      <OddsBar yes={yes} no={no} estimated={estimated} loading={isLoading} />

      {/* The market-implied distribution of today's close */}
      <DistributionCurve ticker={ticker} dist={dist} spotCents={spotCents} loading={isLoading} />

      {/* Compact Yes/No entries into the real market */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 18 }}>
        <OutcomeTile href={href} label="Yes" sub="closes at or above" cents={yes} estimated={estimated} tone="up" />
        <OutcomeTile href={href} label="No" sub="closes below" cents={no} estimated={estimated} tone="dn" />
      </div>

      <p style={{ fontSize: 12.5, color: "var(--text-3)", margin: "14px 0 0", lineHeight: 1.5 }}>
        {yes != null ? (
          <>
            The curve is the market&apos;s view of where {ticker} closes, read from every
            strike&apos;s price. Buy Yes for {estimated ? "~" : ""}
            {fmtDollars(yes)} to win $1.00 if it closes at or above {strikeLabel}.
          </>
        ) : isLoading ? (
          "Reading the live order book…"
        ) : (
          `No market is open for ${ticker} right now.`
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Odds split bar — Yes fills from the left, animates to the live probability.
// ---------------------------------------------------------------------------
function OddsBar({
  yes,
  no,
  estimated,
  loading,
}: {
  yes: number | null;
  no: number | null;
  estimated: boolean;
  loading: boolean;
}) {
  // Gate the very first paint so the bar grows from 0 (skipped under
  // prefers-reduced-motion via the CSS transition being instant there).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const yesPct = yes != null ? clamp(yes, 0, 100) : null;
  const fill = ready && yesPct != null ? yesPct : 0;
  const mark = estimated ? "~" : "";

  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7 }}>
          <span className="num" style={{ fontSize: 26, fontWeight: 600, color: "var(--up)", letterSpacing: "-0.02em" }}>
            {yesPct != null ? `${mark}${yesPct}%` : loading ? "…" : "—"}
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--up)", letterSpacing: "0.02em" }}>YES</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--down)", letterSpacing: "0.02em" }}>NO</span>
          <span className="num" style={{ fontSize: 26, fontWeight: 600, color: "var(--down)", letterSpacing: "-0.02em" }}>
            {no != null ? `${mark}${no}%` : loading ? "…" : "—"}
          </span>
        </span>
      </div>
      <div
        role="img"
        aria-label={yesPct != null ? `Market odds: Yes ${yesPct}%, No ${100 - yesPct}%` : "Market odds loading"}
        style={{
          position: "relative",
          height: 12,
          borderRadius: 999,
          background: "var(--down-soft)",
          overflow: "hidden",
          border: "1px solid var(--line-soft)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${fill}%`,
            background: "linear-gradient(90deg, oklch(0.62 0.15 162), var(--up))",
            borderRadius: 999,
            transition: "width .7s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Implied distribution — a smooth area curve drawn from the strike chain.
// ---------------------------------------------------------------------------
function DistributionCurve({
  ticker,
  dist,
  spotCents,
  loading,
}: {
  ticker: Ticker;
  dist: ImpliedDistributionResult | null;
  spotCents: number | null;
  loading: boolean;
}) {
  if (!dist) {
    return (
      <div
        style={{
          marginTop: 18,
          height: 150,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--r)",
          background: "var(--bg-elev-2)",
          border: "1px solid var(--line-soft)",
          color: "var(--text-3)",
          fontSize: 12.5,
        }}
      >
        {loading ? "Building today's implied distribution…" : "Not enough strikes yet to draw a distribution."}
      </div>
    );
  }

  const W = 720;
  const H = 150;
  const padL = 10;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const xRange = Math.max(1, dist.maxK - dist.minK);

  const xFor = (k: number) => padL + ((clamp(k, dist.minK, dist.maxK) - dist.minK) / xRange) * plotW;
  const yFor = (d: number) => (dist.maxDensity <= 0 ? baseY : baseY - (d / dist.maxDensity) * plotH);

  // Curve points: density at each bar midpoint, anchored to baseline at both ends.
  const pts: [number, number][] = [
    [xFor(dist.minK), baseY],
    ...dist.bars.map((b) => [xFor(b.mid), yFor(b.density)] as [number, number]),
    [xFor(dist.maxK), baseY],
  ];
  const line = smoothPath(pts);
  const area = `${line} L${xFor(dist.maxK)},${baseY} L${xFor(dist.minK)},${baseY} Z`;

  const meanX = xFor(dist.mean);
  const spotX = spotCents != null ? xFor(spotCents) : null;
  const loX = xFor(dist.mean - dist.std);
  const hiX = xFor(dist.mean + dist.std);

  return (
    <div style={{ marginTop: 16 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label={`Market-implied distribution for ${ticker} close today`}>
        <defs>
          <linearGradient id="heroFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* ±1σ band — the implied "likely range" */}
        <rect x={loX} y={padT} width={Math.max(0, hiX - loX)} height={plotH} fill="var(--accent)" fillOpacity={0.06} />

        {/* baseline */}
        <line x1={padL} x2={W - padR} y1={baseY} y2={baseY} stroke="var(--line)" strokeWidth={1} />

        {/* area + curve (re-keys per ticker so it redraws on switch) */}
        <g key={ticker}>
          <path d={area} fill="url(#heroFill)" />
          <path
            d={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
            style={{ strokeDasharray: 1, ["--draw-len" as string]: 1, animation: "drawCurve .9s cubic-bezier(0.22,1,0.36,1) both" }}
          />
        </g>

        {/* implied mean marker */}
        <line x1={meanX} x2={meanX} y1={padT} y2={baseY} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" />
        <text x={meanX} y={padT - 3} fontSize="10" fill="var(--accent)" textAnchor="middle" fontFamily="var(--mono)">
          μ {fmtStockPrice(dist.mean)}
        </text>

        {/* spot marker */}
        {spotX != null && (
          <>
            <line x1={spotX} x2={spotX} y1={padT} y2={baseY} stroke="var(--warn)" strokeWidth={1.25} />
            <circle cx={spotX} cy={baseY} r={3} fill="var(--warn)" />
          </>
        )}

        {/* axis ends */}
        <text x={padL} y={H - 7} fontSize="10" fill="var(--text-3)" textAnchor="start" fontFamily="var(--mono)">
          {fmtStockPrice(dist.minK)}
        </text>
        <text x={W - padR} y={H - 7} fontSize="10" fill="var(--text-3)" textAnchor="end" fontFamily="var(--mono)">
          {fmtStockPrice(dist.maxK)}
        </text>
      </svg>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 4, fontSize: 12, color: "var(--text-3)" }}>
        <LegendDot color="var(--accent)" label={`Implied close ≈ ${fmtStockPrice(dist.mean)}`} />
        <LegendDot color="var(--warn)" label={spotCents != null ? `Now ${fmtStockPrice(spotCents)}` : "Now —"} />
        <span>
          Likely range{" "}
          <span className="num" style={{ color: "var(--text-2)" }}>
            {fmtStockPrice(dist.mean - dist.std)}–{fmtStockPrice(dist.mean + dist.std)}
          </span>
        </span>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

function OutcomeTile({
  href,
  label,
  sub,
  cents,
  estimated,
  tone,
}: {
  href: string;
  label: string;
  sub: string;
  cents: number | null;
  estimated: boolean;
  tone: "up" | "dn";
}) {
  const color = tone === "up" ? "var(--up)" : "var(--down)";
  const bg = tone === "up" ? "var(--up-soft)" : "var(--down-soft)";
  const line = tone === "up" ? "var(--up-line)" : "var(--down-line)";
  const mark = estimated ? "~" : "";
  return (
    <Link
      href={href}
      className="row-hover"
      style={{
        display: "block",
        padding: "13px 16px",
        borderRadius: 10,
        background: bg,
        border: `1px solid ${line}`,
        textDecoration: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 600, color }}>{label}</span>
        <span className="num" style={{ fontSize: 21, fontWeight: 600, color }}>
          {cents != null ? `${mark}${cents}¢` : "—"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ fontSize: 12, color: "var(--text-3)" }}>{sub}</span>
        <IconCaret size={11} aria-hidden style={{ color }} />
      </div>
    </Link>
  );
}

/** Catmull-Rom → cubic Bézier smoothing for a sequence of points. */
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return "";
  if (points.length < 3) return "M" + points.map((p) => `${r(p[0])},${r(p[1])}`).join(" L");
  let d = `M${r(points[0]![0])},${r(points[0]![1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 >= points.length ? points.length - 1 : i + 2]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2[0])},${r(p2[1])}`;
  }
  return d;
}

const r = (n: number) => Math.round(n * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const fmtDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
