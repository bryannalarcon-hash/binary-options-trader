"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Card,
  IconClock,
  IconPyth,
  IconRefresh,
  IconRight,
  IconSearch,
  Label,
  Seg,
  StrikePill,
  fmt$,
} from "@/components/caret";
import { MarketStatusChip } from "@/components/MarketStatusChip";
import {
  useAllMarkets,
  useSpotPrice,
  useStrikeList,
  type StrikeRow,
} from "@/lib/markets-client";
import { useMounted } from "@/lib/use-mounted";
import { MAG7_TICKERS, TICKER_NAME, type Ticker } from "@/lib/tickers";
import type { Market } from "@meridian/types";

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

type View = "grid" | "list" | "heatmap";

/**
 * Markets — REAL on-chain data only.
 *
 * Markets come from `useAllMarkets()`; per-ticker spot from `useSpotPrice()`
 * (on-chain OracleAccount) and strike chains from `useStrikeList()` (derived
 * from real markets + real order-book mids). No mock spot / change / strikes.
 *
 * Three view modes: Grid / List / Heat.
 */
export default function MarketsPage() {
  const [view, setView] = useState<View>("grid");
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  void refreshKey;
  const mounted = useMounted();

  const { markets } = useAllMarkets();

  // Static per-stock metadata (no synthesized prices). Spot + strikes are read
  // live inside each card via real hooks.
  const stocks = useMemo<StockRow[]>(() => {
    return MAG7_TICKERS.map((t) => ({
      sym: t,
      name: TICKER_NAME[t],
      sector: sectorFor(t),
    }));
  }, []);

  const filtered = stocks.filter((s) => {
    if (
      search &&
      !s.sym.toLowerCase().includes(search.toLowerCase()) &&
      !s.name.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => a.sym.localeCompare(b.sym));

  return (
    <div className="page">
      {/* HEADER */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 24,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <Label>
            MAG7
            {mounted
              ? ` · ${new Date().toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}`
              : ""}
          </Label>
          <h2 style={{ marginTop: 6 }}>Markets</h2>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-3)" }}>
            7 stocks · {markets.filter((m) => !m.settled).length || "—"} active
            strikes · settles at 4:00 PM ET
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <MarketStatusChip />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--text-3)",
            }}
          >
            <IconClock size={12} />
            <span>Settles at 4:00 PM ET</span>
          </div>
        </div>
      </div>

      {/* TOOLBAR */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          padding: "12px 14px",
          background: "var(--bg-elev)",
          borderRadius: 10,
          border: "1px solid var(--line-soft)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flex: 1, maxWidth: 360, minWidth: 200 }}>
          <IconSearch
            size={13}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-3)",
            }}
          />
          <input
            className="field"
            placeholder="Search MAG7 (AAPL, MSFT, …)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 34, height: 34 }}
          />
        </div>

        <div style={{ flex: 1 }} />

        <Seg
          options={[
            { value: "grid" as View, label: "Grid" },
            { value: "list" as View, label: "List" },
            { value: "heatmap" as View, label: "Heat" },
          ]}
          value={view}
          onChange={setView}
        />

        <button
          className="btn sm ghost"
          title="Refresh"
          onClick={() => setRefreshKey((k) => k + 1)}
          type="button"
        >
          <IconRefresh size={13} />
        </button>
      </div>

      {/* CONTENT */}
      {view === "grid" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))",
            gap: 16,
          }}
        >
          {sorted.map((s) => (
            <StockCard key={s.sym} stock={s} />
          ))}
        </div>
      )}

      {view === "list" && (
        <Card padding={0} style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Ticker</th>
                <th style={{ textAlign: "right" }}>Spot</th>
                <th style={{ textAlign: "right" }}>Δ</th>
                <th style={{ textAlign: "left", paddingLeft: 24 }}>
                  Strike chain
                </th>
                <th style={{ textAlign: "right" }}>24h vol</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <StockListRow key={s.sym} stock={s} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {view === "heatmap" && <Heatmap stocks={sorted} markets={markets} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stock card (grid view)
// ---------------------------------------------------------------------------
interface StockRow {
  sym: Ticker;
  name: string;
  sector: string;
}

function StockCard({ stock }: { stock: StockRow }) {
  const router = useRouter();
  const { rows: chain, loading: chainLoading } = useStrikeList(stock.sym);
  const { spotUsd } = useSpotPrice(stock.sym);
  const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;
  const atm = atmFromRows(chain, spotCents);
  // Real volume = sum of observed OrderMatched fills across this ticker's
  // strikes; 0 until any fill is seen.
  const totalVol = chain.reduce((sum, c) => sum + c.volume, 0);
  // Link to the ATM strike when known, else the first available strike.
  const href = atm != null
    ? `/trade/${stock.sym}/${atm}`
    : chain.length > 0
      ? `/trade/${stock.sym}/${chain[0]!.strike}`
      : `/trade/${stock.sym}`;

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") router.push(href);
      }}
      style={{ textDecoration: "none", display: "block", cursor: "pointer" }}
    >
      <div
        className="card"
        style={{
          padding: 18,
          transition: "border-color .15s, transform .15s",
          cursor: "pointer",
          height: "100%",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--line-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--line-soft)";
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                marginBottom: 2,
              }}
            >
              <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>
                {stock.sym}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                {stock.name}
              </span>
            </div>
            <span
              style={{
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-4)",
              }}
            >
              {stock.sector}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", flexDirection: "column", gap: 4 }}>
            <span className="num" style={{ fontSize: 19, fontWeight: 500 }}>
              {spotUsd != null ? fmt$(spotUsd) : "—"}
            </span>
            <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-4)" }}>
              oracle spot
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 0",
            borderTop: "1px solid var(--line-soft)",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <span
            style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-3)" }}
          >
            VOL{" "}
            <span style={{ color: "var(--text-2)" }}>
              {totalVol > 0 ? totalVol.toLocaleString() : "—"}
            </span>
          </span>
          <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
            {chainLoading && chain.length === 0 ? (
              <span style={{ color: "var(--text-3)" }}>loading…</span>
            ) : (
              <>
                <span style={{ color: "var(--text-2)" }}>{chain.length}</span> strikes
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${Math.max(chain.length, 1)}, 1fr)`,
              gap: 4,
            }}
          >
            {chain.map((c) => {
              const isAtm = c.strike === atm;
              const winner = Math.max(c.yesCents, c.noCents);
              const winnerSide = c.yesCents > c.noCents ? "up" : "down";
              return (
                <Link
                  key={c.strike}
                  href={`/trade/${stock.sym}/${c.strike}`}
                  onClick={(e) => e.stopPropagation()}
                  className="row-hover"
                  style={{
                    padding: "6px 2px",
                    background: isAtm ? "var(--accent-soft)" : "var(--bg-elev-2)",
                    border: isAtm
                      ? "1px solid var(--accent-line)"
                      : "1px solid var(--line-soft)",
                    borderRadius: 5,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                    fontFamily: "var(--mono)",
                    cursor: "pointer",
                    textDecoration: "none",
                    color: "var(--text)",
                  }}
                >
                  <span style={{ fontSize: 10, color: "var(--text-3)" }}>
                    ${(c.strike / 100).toFixed(0)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: `var(--${winnerSide})`,
                      fontWeight: 600,
                    }}
                  >
                    {winner}¢
                  </span>
                </Link>
              );
            })}
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-3)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <IconPyth size={11} /> {stock.sym}/USD
          </span>
          <span>
            VOL{" "}
            <span style={{ color: "var(--text-2)" }}>
              {totalVol > 0 ? totalVol.toLocaleString() : "—"}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stock list row
// ---------------------------------------------------------------------------
function StockListRow({ stock }: { stock: StockRow }) {
  const { rows: chain } = useStrikeList(stock.sym);
  const { spotUsd } = useSpotPrice(stock.sym);
  const spotCents = spotUsd != null ? Math.round(spotUsd * 100) : null;
  const atm = atmFromRows(chain, spotCents);
  const totalVol = chain.reduce((sum, c) => sum + c.volume, 0);
  const navTarget = atm != null
    ? `/trade/${stock.sym}/${atm}`
    : chain.length > 0
      ? `/trade/${stock.sym}/${chain[0]!.strike}`
      : `/trade/${stock.sym}`;

  return (
    <tr
      className="row-hover"
      style={{ cursor: "pointer" }}
      onClick={() => {
        window.location.href = navTarget;
      }}
    >
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{stock.sym}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>{stock.name}</div>
          </div>
        </div>
      </td>
      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
        {spotUsd != null ? fmt$(spotUsd) : "—"}
      </td>
      <td
        style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-4)" }}
      >
        —
      </td>
      <td style={{ paddingLeft: 24 }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {chain.map((c) => {
            const isAtm = c.strike === atm;
            const winner = Math.max(c.yesCents, c.noCents);
            const winnerSide = c.yesCents > c.noCents ? "up" : "down";
            return (
              <Link
                key={c.strike}
                href={`/trade/${stock.sym}/${c.strike}`}
                onClick={(e) => e.stopPropagation()}
                style={{
                  padding: "5px 8px",
                  background: isAtm ? "var(--accent-soft)" : "var(--bg-elev-2)",
                  border: isAtm
                    ? "1px solid var(--accent-line)"
                    : "1px solid transparent",
                  borderRadius: 5,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  minWidth: 56,
                  textDecoration: "none",
                }}
              >
                <span style={{ color: "var(--text-3)", fontSize: 10 }}>
                  {(c.strike / 100).toFixed(0)}
                </span>
                <span
                  style={{
                    color: `var(--${winnerSide})`,
                    fontWeight: 600,
                  }}
                >
                  {winner}¢
                </span>
              </Link>
            );
          })}
        </div>
      </td>
      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
        {totalVol > 0 ? totalVol.toLocaleString() : "—"}
      </td>
      <td style={{ textAlign: "right", paddingRight: 18 }}>
        <IconRight size={14} style={{ color: "var(--text-3)" }} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------
function Heatmap({
  stocks,
  markets,
}: {
  stocks: StockRow[];
  markets: Market[];
}) {
  const buckets = ["−9%", "−6%", "−3%", "Close", "+3%", "+6%", "+9%"];
  const pcts = [-0.09, -0.06, -0.03, 0, 0.03, 0.06, 0.09];

  return (
    <Card padding={0} style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid var(--line-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span className="label">
          Implied Yes % by ticker × strike offset
        </span>
        <span
          style={{
            display: "flex",
            gap: 18,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-3)",
            flexWrap: "wrap",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{ width: 10, height: 10, borderRadius: 2, background: "var(--up)" }}
            />{" "}
            100% Yes
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: "var(--bg-elev-2)",
              }}
            />{" "}
            50/50
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{ width: 10, height: 10, borderRadius: 2, background: "var(--down)" }}
            />{" "}
            100% No
          </span>
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `140px repeat(${buckets.length}, 1fr)`,
          padding: 14,
          gap: 4,
        }}
      >
        <div />
        {buckets.map((b) => (
          <div
            key={b}
            style={{
              textAlign: "center",
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
              padding: "4px 0",
            }}
          >
            {b}
          </div>
        ))}
        {stocks.map((s) => (
          <HeatmapRow key={s.sym} stock={s} pcts={pcts} markets={markets} />
        ))}
      </div>
    </Card>
  );
}

function HeatmapRow({
  stock,
  pcts,
  markets,
}: {
  stock: StockRow;
  pcts: number[];
  markets: Market[];
}) {
  const { rows: chain } = useStrikeList(stock.sym);
  const { spotUsd } = useSpotPrice(stock.sym);
  // Anchor the ±% buckets to the REAL oracle spot (cents). Null until read.
  const baseCents = spotUsd != null ? spotUsd * 100 : null;

  function cellFor(idx: number) {
    if (baseCents == null || chain.length === 0) {
      return { strikeCents: 0, yes: undefined as number | undefined };
    }
    const targetCents = Math.round((baseCents * (1 + pcts[idx]!)) / 1000) * 1000;
    // Find the strike closest to the targeted offset.
    let best = chain[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of chain) {
      const d = Math.abs(c.strike - targetCents);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return { strikeCents: best?.strike ?? targetCents, yes: best?.yesCents };
  }

  // markets unused for color math (kept for signature parity with Heatmap).
  void markets;

  return (
    <>
      <div style={{ padding: "12px 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 500, fontSize: 13 }}>{stock.sym}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>
          {spotUsd != null ? fmt$(spotUsd) : "—"}
        </span>
      </div>
      {pcts.map((_, idx) => {
        const cell = cellFor(idx);
        if (cell.yes == null) {
          return (
            <div
              key={idx}
              style={{
                background: "var(--bg-elev-2)",
                opacity: 0.3,
                borderRadius: 5,
              }}
            />
          );
        }
        const t = cell.yes / 100;
        const bg = `oklch(${0.32 + Math.abs(t - 0.5) * 0.18} ${
          0.04 + Math.abs(t - 0.5) * 0.14
        } ${t > 0.5 ? 158 : 25})`;
        return (
          <Link
            key={idx}
            href={`/trade/${stock.sym}/${cell.strikeCents}`}
            style={{
              background: bg,
              border: 0,
              borderRadius: 5,
              padding: "12px 4px",
              fontFamily: "var(--mono)",
              color: "var(--text)",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              textDecoration: "none",
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{cell.yes}¢</span>
            <span style={{ fontSize: 10, color: "var(--text-3)" }}>
              ${(cell.strikeCents / 100).toFixed(0)}
            </span>
          </Link>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sector lookup (display only — for the StockCard subtitle).
// ---------------------------------------------------------------------------
function sectorFor(t: Ticker): string {
  switch (t) {
    case "AAPL":
    case "MSFT":
    case "GOOGL":
    case "META":
      return "Tech";
    case "AMZN":
      return "Consumer";
    case "NVDA":
      return "Semis";
    case "TSLA":
      return "Auto";
  }
}

// Tiny ack to keep StrikePill import alive for future ATM-badge work
// without triggering unused-import lint.
void StrikePill;
