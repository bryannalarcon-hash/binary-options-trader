"use client";

import { useMemo } from "react";
import { TrendingUp } from "lucide-react";

import { fmtStockPrice } from "@/lib/format";
import { TICKER_NAME, type Ticker } from "@/lib/tickers";

/**
 * One strike on the chain: K in cents (e.g. 22050 == $220.50) and the live
 * Yes price in cents (0..100).
 */
export interface StrikePoint {
  strike: number;
  yesPrice: number;
}

interface Props {
  ticker: Ticker;
  strikes: StrikePoint[];
  /** Current spot price in cents (e.g. 22050). Drawn as a vertical marker. */
  currentPrice?: number;
}

/**
 * ImpliedDistribution — Breeden-Litzenberger style risk-neutral PDF.
 *
 * Math:
 *   Strikes K_1 < K_2 < ... < K_n, Yes prices p_1 > p_2 > ... > p_n.
 *   Implied CDF: F(K_i) = 1 - p_i (Yes pays $1 iff S_T >= K_i).
 *   Implied PDF (density at midpoint of [K_i, K_{i+1}]):
 *       f_i = (p_i - p_{i+1}) / (K_{i+1} - K_i)
 *   Implied mean:
 *       E[S_T] ≈ Σ midpoint_i * f_i * (K_{i+1} - K_i)
 *              = Σ midpoint_i * (p_i - p_{i+1})
 *
 * We draw a histogram of the density (bar per midpoint), plus a vertical
 * marker for the current spot and another for the implied mean.
 *
 * No external chart lib — plain SVG so we don't blow up the bundle.
 */
export function ImpliedDistribution({ ticker, strikes, currentPrice }: Props) {
  const stats = useMemo(() => computeBL(strikes), [strikes]);

  // Empty / degenerate state — fewer than 2 strikes means no slope to take.
  if (!stats) {
    return (
      <Frame ticker={ticker}>
        <div className="flex h-40 items-center justify-center text-center text-xs text-zinc-500">
          Not enough strikes to derive a distribution yet.
        </div>
      </Frame>
    );
  }

  const { bars, minK, maxK, maxDensity, impliedMean } = stats;

  // SVG viewBox geometry — fixed virtual coords, scaled by CSS.
  const W = 320;
  const H = 140;
  const padL = 8;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xRange = Math.max(1, maxK - minK);

  function xFor(k: number): number {
    return padL + ((k - minK) / xRange) * plotW;
  }
  function yFor(density: number): number {
    if (maxDensity <= 0) return padT + plotH;
    return padT + plotH - (density / maxDensity) * plotH;
  }

  const spotX = currentPrice != null ? xFor(clamp(currentPrice, minK, maxK)) : null;
  const meanX = xFor(clamp(impliedMean, minK, maxK));

  return (
    <Frame ticker={ticker}>
      <div className="px-4 pb-4">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-40 w-full"
          role="img"
          aria-label={`Market-implied PDF for ${ticker} close today`}
        >
          {/* Baseline */}
          <line
            x1={padL}
            x2={W - padR}
            y1={padT + plotH}
            y2={padT + plotH}
            stroke="var(--line)"
            strokeWidth={1}
          />
          {/* Bars (density) */}
          {bars.map((b, i) => {
            const x0 = xFor(b.lo);
            const x1 = xFor(b.hi);
            const yTop = yFor(b.density);
            const yBase = padT + plotH;
            const barW = Math.max(1, x1 - x0 - 1);
            return (
              <g key={i}>
                <rect
                  x={x0 + 0.5}
                  y={yTop}
                  width={barW}
                  height={Math.max(0, yBase - yTop)}
                  fill="var(--accent)"
                  fillOpacity={0.35}
                  stroke="var(--accent)"
                  strokeOpacity={0.7}
                  strokeWidth={0.5}
                />
                <title>
                  {fmtStockPrice(b.lo)}–{fmtStockPrice(b.hi)}: {Math.round(b.prob * 100)}%
                </title>
              </g>
            );
          })}
          {/* Implied mean marker */}
          <line
            x1={meanX}
            x2={meanX}
            y1={padT}
            y2={padT + plotH}
            stroke="var(--accent)"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
          <text
            x={meanX}
            y={padT + 8}
            fontSize="9"
            fill="var(--accent)"
            textAnchor={meanX > padL + plotW - 40 ? "end" : "start"}
            dx={meanX > padL + plotW - 40 ? -3 : 3}
          >
            μ {fmtStockPrice(impliedMean)}
          </text>
          {/* Spot marker */}
          {spotX != null && (
            <>
              <line
                x1={spotX}
                x2={spotX}
                y1={padT}
                y2={padT + plotH}
                stroke="var(--warn)"
                strokeWidth={1.25}
              />
              <text
                x={spotX}
                y={padT + 18}
                fontSize="9"
                fill="var(--warn)"
                textAnchor={spotX > padL + plotW - 40 ? "end" : "start"}
                dx={spotX > padL + plotW - 40 ? -3 : 3}
              >
                spot {fmtStockPrice(currentPrice!)}
              </text>
            </>
          )}
          {/* X-axis labels: min, max */}
          <text
            x={padL}
            y={H - 6}
            fontSize="9"
            fill="var(--text-3)"
            textAnchor="start"
          >
            {fmtStockPrice(minK)}
          </text>
          <text
            x={W - padR}
            y={H - 6}
            fontSize="9"
            fill="var(--text-3)"
            textAnchor="end"
          >
            {fmtStockPrice(maxK)}
          </text>
        </svg>

        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="Implied mean" value={fmtStockPrice(impliedMean)} accent />
          <Stat
            label="Spot"
            value={currentPrice != null ? fmtStockPrice(currentPrice) : "—"}
          />
          <Stat
            label="Implied vs spot"
            value={
              currentPrice != null
                ? fmtSignedPct(((impliedMean - currentPrice) / currentPrice) * 100)
                : "—"
            }
            tone={
              currentPrice != null
                ? impliedMean - currentPrice >= 0
                  ? "yes"
                  : "no"
                : undefined
            }
          />
        </div>
      </div>
    </Frame>
  );
}

function Frame({
  ticker,
  children,
}: {
  ticker: Ticker;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <TrendingUp size={14} className="text-accent" />
            Market-implied distribution for {ticker} close today
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {TICKER_NAME[ticker]} · From the strike chain via Breeden-Litzenberger
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: "yes" | "no";
}) {
  const valueClass = tone === "yes"
    ? "text-yes"
    : tone === "no"
      ? "text-no"
      : accent
        ? "text-accent"
        : "text-zinc-100";
  return (
    <div className="rounded-md border border-border bg-bg/40 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm ${valueClass}`}>{value}</p>
    </div>
  );
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function fmtSignedPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Breeden-Litzenberger: derive an implied PDF from the strike chain.
 *
 * Yes-price interpretation: p_i = P(S_T >= K_i). So 1 - p_i is the CDF at K_i.
 * The implied PDF at the midpoint of [K_i, K_{i+1}] is therefore:
 *   ((1 - p_{i+1}) - (1 - p_i)) / (K_{i+1} - K_i) = (p_i - p_{i+1}) / (K_{i+1} - K_i)
 *
 * Returns null if we have fewer than 2 strikes (can't take a slope).
 */
function computeBL(input: StrikePoint[]): {
  bars: { lo: number; hi: number; mid: number; density: number; prob: number }[];
  minK: number;
  maxK: number;
  maxDensity: number;
  impliedMean: number;
} | null {
  if (!input || input.length < 2) return null;

  // Sort ascending by strike. Convert Yes price (cents) → probability ∈ [0,1].
  const sorted = [...input]
    .map((s) => ({ strike: s.strike, p: clamp(s.yesPrice, 0, 100) / 100 }))
    .filter((s) => Number.isFinite(s.strike) && Number.isFinite(s.p))
    .sort((a, b) => a.strike - b.strike);

  if (sorted.length < 2) return null;

  // Enforce monotonicity (yes prices should be non-increasing in strike). Clip
  // small noise so a single mispriced strike doesn't produce a negative density.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.p > sorted[i - 1]!.p) {
      sorted[i]!.p = sorted[i - 1]!.p;
    }
  }

  const bars: { lo: number; hi: number; mid: number; density: number; prob: number }[] = [];
  let probSum = 0;
  let meanNum = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const k0 = sorted[i]!.strike;
    const k1 = sorted[i + 1]!.strike;
    const width = k1 - k0;
    if (width <= 0) continue;
    const probMass = Math.max(0, sorted[i]!.p - sorted[i + 1]!.p);
    const density = probMass / width;
    const mid = (k0 + k1) / 2;
    bars.push({ lo: k0, hi: k1, mid, density, prob: probMass });
    probSum += probMass;
    meanNum += mid * probMass;
  }

  if (bars.length === 0) return null;

  // Implied mean: weighted average of midpoints by probability mass. If the
  // chain doesn't span the full distribution (which it never does — we only
  // see ±9% from spot) the probSum will be < 1; we normalize to the visible
  // mass so the mean stays inside the chain.
  const impliedMean = probSum > 0 ? meanNum / probSum : (bars[0]!.lo + bars[bars.length - 1]!.hi) / 2;
  const maxDensity = bars.reduce((m, b) => (b.density > m ? b.density : m), 0);

  return {
    bars,
    minK: sorted[0]!.strike,
    maxK: sorted[sorted.length - 1]!.strike,
    maxDensity,
    impliedMean,
  };
}
