"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import {
  Button,
  Card,
  IconCaret,
  IconExt,
  Label,
  Pill,
  Seg,
  Stat,
  StrikePill,
  fmt$,
} from "@/components/caret";
import { ImpliedDistribution } from "@/components/ImpliedDistribution";
import { ConfirmTradeModal } from "@/components/ConfirmTradeModal";
import { PositionConstraintModal } from "@/components/PositionConstraintModal";
import {
  buildAndSendTrade,
  type BuildTradeArgs,
} from "@/lib/composite-tx";
import { explorerTx } from "@/lib/explorer";
import { fmtUsdDollars } from "@/lib/format";
import {
  useMarket,
  useOrderBook,
  useRecentTrades,
  useSpotPrice,
  useStrikeList,
  type StrikeRow,
} from "@/lib/markets-client";
import { marketStatus } from "@/lib/market-hours";
import { reRollStrike } from "@/lib/admin-tx";
import { env } from "@/lib/env";
import { notify } from "@/lib/notify";
import { useHoldingForMarket } from "@/lib/positions-client";
import { OpenOrdersForMarket } from "@/lib/open-orders";
import { bumpTradeCount, useSettings } from "@/lib/settings";
import { TICKER_NAME, PYTH_FEED_ID, type Ticker } from "@/lib/tickers";
import { useUsdcBalance } from "@/lib/usdc";
import { useMounted } from "@/lib/use-mounted";
import { MarketStatusChip } from "@/components/MarketStatusChip";
import type { Order, Outcome, Side } from "@meridian/types";

interface Props {
  ticker: Ticker;
  strike: number; // cents
}

type TradeView = "book" | "pdf" | "intraday" | "ladder";

// Parabolic taker-fee curve — must mirror the on-chain contract EXACTLY.
// programs/meridian/src/instructions/place_order.rs::compute_taker_fee
//   taker_fee_bps = PEAK_TAKER_FEE_BPS * 4 * p * (100 - p) / 10_000   (p = yes price in cents, 1..=99)
// Peak 150 bps (1.5%) at p=50; ~5 bps at p=1/99 (integer-truncated).
const PEAK_TAKER_FEE_BPS = 150;

/** Integer-truncated taker fee in bps for a given yes price in cents (1..99). */
function takerFeeBps(priceCents: number): number {
  const p = Math.max(0, Math.min(100, Math.floor(priceCents)));
  if (p === 0 || p >= 100) return 0;
  return Math.floor((PEAK_TAKER_FEE_BPS * 4 * p * (100 - p)) / 10_000);
}

/**
 * Taker fee in USDC dollars, matching the contract's integer-truncated
 * micro-USDC math. `costDollars` is the trade notional in dollars; `priceCents`
 * is the yes price the fee curve is evaluated at.
 */
function takerFeeDollars(costDollars: number, priceCents: number): number {
  const bps = takerFeeBps(priceCents);
  const notionalMicro = Math.round(costDollars * 1_000_000);
  const feeMicro = Math.floor((notionalMicro * bps) / 10_000);
  return feeMicro / 1_000_000;
}

/**
 * Trade page client — caret 3-column layout with header strip.
 *
 * Preserves every real on-chain hook used by the original page:
 *   - useMarket / useOrderBook / useRecentTrades / useStrikeList (markets-client)
 *   - useHoldingForMarket (positions-client)
 *   - buildAndSendTrade / buildCloseAndReverseTrade (composite-tx)
 *   - useSettings + bumpTradeCount
 *   - useUsdcBalance
 *
 * No mock data is introduced — every value comes from the existing hooks
 * (which already gracefully degrade to deterministic mocks on lib failures).
 */
export function TradePageClient({ ticker, strike }: Props) {
  const mounted = useMounted();
  const [tradeView, setTradeView] = useState<TradeView>("book");
  const { market } = useMarket(ticker, strike);
  const { book, loading: bookLoading } = useOrderBook(ticker, strike);
  const { trades } = useRecentTrades(ticker, strike);
  const { rows: strikeList, loading: strikeLoading } = useStrikeList(ticker);
  const holding = useHoldingForMarket(ticker, strike);
  const { spotUsd, loading: spotLoading } = useSpotPrice(ticker);

  // Real oracle spot — null until the OracleAccount PDA read settles. We NEVER
  // substitute a fake number; downstream renders "—" while null.
  const spotDollars = spotUsd; // number | null
  const strikeDollars = strike / 100;

  const yesMid =
    book && book.asks[0] && book.bids[0]
      ? Math.round((book.asks[0].price + book.bids[0].price) / 2)
      : null;
  const noMid = yesMid != null ? 100 - yesMid : null;
  const spread =
    book && book.asks[0] && book.bids[0]
      ? Math.abs(book.asks[0].price - book.bids[0].price)
      : null;

  // Unified display price for THIS strike. The strike chain derives its number
  // from the order-book mid OR (empty book) an oracle-spot estimate; the header
  // and trade panel previously used ONLY the book mid (→ 50¢ default when empty),
  // so they disagreed with the chain. Prefer the real book mid, else fall back to
  // the same estimate the chain shows, so all three panels match.
  const strikeRow = strikeList.find((s) => s.strike === strike) ?? null;
  const yesDisplay = yesMid ?? strikeRow?.yesCents ?? null;
  const noDisplay = yesDisplay != null ? 100 - yesDisplay : null;
  // The price is an ESTIMATE (not an executable quote) whenever there is no
  // two-sided book mid — i.e. the displayed number comes from the oracle-vs-strike
  // proxy in the strike chain, not from resting bids/asks. The UI must mark it so
  // a user doesn't read "62¢" as "I can buy here right now".
  const priceEstimated = yesDisplay != null && yesMid == null;

  const inMoney = spotDollars != null ? spotDollars >= strikeDollars : null;
  const distPct =
    spotDollars != null ? ((spotDollars - strikeDollars) / strikeDollars) * 100 : null;

  // Real 24h volume = sum of observed OrderMatched fill sizes for this strike.
  const vol24 = useMemo(
    () => trades.reduce((s, t) => s + t.size, 0),
    [trades],
  );
  // Time-dependent label — only compute after mount to avoid SSR/CSR
  // hydration mismatch (Date.now() differs between server and client render).
  const settlesIn = mounted ? settlesInLabel(market?.expiryTs ?? null) : "—";

  // Settled (read-only) market: after the 4 PM ET close the on-chain market is
  // settled and `place_order` reverts AlreadySettled — so we switch the page to
  // read-only (resolved banner + redeem path) and disable order entry. mint/
  // redeem stay available. The settlement-time label is gated behind useMounted
  // (it formats a Date) to stay hydration-safe.
  const isSettled = !!market?.settled;
  const settledOutcome = market?.outcome ?? null;
  const settledPriceDollars =
    market?.settlementPrice != null ? market.settlementPrice / 100 : null;
  const settledAtLabel =
    mounted && market?.settlementTs != null
      ? new Date(market.settlementTs * 1000).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    <div className="page" style={{ paddingTop: 24 }}>
      {/* HEADER STRIP */}
      <TradeHeader
        ticker={ticker}
        strikeDollars={strikeDollars}
        spotDollars={spotDollars}
        spotLoading={spotLoading}
        yes={yesDisplay}
        no={noDisplay}
        estimated={priceEstimated}
        inMoney={inMoney}
        distPct={distPct}
        vol24={vol24}
        spread={spread}
        settlesIn={settlesIn}
      />

      {isSettled && (
        <ResolvedBanner
          ticker={ticker}
          strikeDollars={strikeDollars}
          outcome={settledOutcome}
          settlementDollars={settledPriceDollars}
          settledAtLabel={settledAtLabel}
        />
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "260px minmax(0, 1fr) 340px",
          gap: 16,
          marginTop: 16,
        }}
      >
        {/* LEFT RAIL */}
        <div className="stack">
          <StrikeChain
            ticker={ticker}
            strike={strike}
            spotDollars={spotDollars}
            strikes={strikeList}
            loading={strikeLoading}
          />

          <Card padding={14} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div
                style={{ fontSize: 11, color: "var(--text-3)" }}
                title="Prices sourced from Pyth Network, written on-chain at settlement."
              >
                Settles via Pyth
              </div>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  marginTop: 4,
                  color: "var(--text)",
                }}
              >
                {ticker}/USD
              </div>
            </div>
            <a
              href={`https://pyth.network/price-feeds/equity-us-${ticker.toLowerCase()}-usd`}
              target="_blank"
              rel="noopener noreferrer"
              title={PYTH_FEED_ID[ticker]}
              style={{ color: "var(--text-3)", display: "inline-flex" }}
            >
              <IconExt size={14} />
            </a>
          </Card>

          <Card padding={14}>
            <div className="label" style={{ marginBottom: 8 }}>
              Contract
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <Stat k="Type" v="Binary / 0DTE" />
              <Stat k="Expiry" v="Today 4:00 PM ET" />
              <Stat k="Settles" v="Pyth" />
              <Stat k="CLOB" v="On-chain" />
            </div>
          </Card>
        </div>

        {/* CENTER */}
        <div className="stack">
          <Card padding={0}>
            <div className="tabs" style={{ paddingLeft: 8 }}>
              {(
                [
                  { id: "book", label: "Order book" },
                  { id: "pdf", label: "Implied PDF" },
                  { id: "intraday", label: "Intraday spot" },
                  { id: "ladder", label: "Strike ladder" },
                ] as { id: TradeView; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  className={tradeView === t.id ? "on" : ""}
                  onClick={() => setTradeView(t.id)}
                  type="button"
                >
                  {t.label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <div
                style={{
                  alignSelf: "center",
                  paddingRight: 14,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text-3)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <MarketStatusChip />
                {ticker} · {spotDollars != null ? fmt$(spotDollars) : "—"}
                <DevReRollButton ticker={ticker} strike={strike} />
              </div>
            </div>

            <div>
              {tradeView === "book" && book && (book.bids.length > 0 || book.asks.length > 0) && (
                <OrderBook
                  bids={book.bids}
                  asks={book.asks}
                  yes={yesDisplay ?? 50}
                  spread={spread ?? 0}
                />
              )}
              {tradeView === "book" && book && book.bids.length === 0 && book.asks.length === 0 && (
                <div
                  style={{
                    padding: 36,
                    textAlign: "center",
                    color: "var(--text-3)",
                    fontSize: 13,
                  }}
                >
                  Order book is empty — be the first to quote.
                </div>
              )}
              {tradeView === "book" && !book && (
                <div
                  style={{
                    padding: 36,
                    textAlign: "center",
                    color: "var(--text-3)",
                    fontSize: 13,
                  }}
                >
                  {bookLoading ? "Loading order book…" : "No order book for this market."}
                </div>
              )}
              {tradeView === "pdf" && (
                <div style={{ padding: 16 }}>
                  {spotDollars != null && strikeList.length > 0 ? (
                    <ImpliedDistribution
                      ticker={ticker}
                      strikes={strikeList.map((s) => ({
                        strike: s.strike,
                        yesPrice: s.yesCents,
                      }))}
                      currentPrice={Math.round(spotDollars * 100)}
                    />
                  ) : (
                    <div
                      style={{
                        padding: 36,
                        textAlign: "center",
                        color: "var(--text-3)",
                        fontSize: 13,
                      }}
                    >
                      Waiting for live oracle + strikes…
                    </div>
                  )}
                </div>
              )}
              {tradeView === "intraday" && (
                <IntradayChart
                  ticker={ticker}
                  spotDollars={spotDollars}
                  strikeDollars={strikeDollars}
                />
              )}
              {tradeView === "ladder" && (
                <SpotStrikeLadder
                  spotDollars={spotDollars}
                  strikeCents={strike}
                  strikes={strikeList}
                />
              )}
            </div>
          </Card>

          <Card padding={0}>
            <div
              style={{
                padding: "12px 18px",
                borderBottom: "1px solid var(--line-soft)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h4>Recent trades</h4>
              <span className="label">
                {ticker} · ${strikeDollars.toFixed(2)}
              </span>
            </div>
            <RecentTradesTable trades={trades} mounted={mounted} />
          </Card>

          <ScenarioStrip
            ticker={ticker}
            spotDollars={spotDollars}
            strikeDollars={strikeDollars}
            holding={holding}
          />
        </div>

        {/* RIGHT RAIL */}
        <div className="stack">
          <TradePanel
            ticker={ticker}
            strikeCents={strike}
            strikeDollars={strikeDollars}
            yes={yesDisplay}
            no={noDisplay}
            estimated={priceEstimated}
            book={book}
            holding={holding}
            settled={isSettled}
            outcome={settledOutcome}
          />
          {/* Resting (unfilled) orders for THIS market, with Cancel. Renders
              nothing when there are none. yes/no may be null on an empty book —
              TradePanel handles it. */}
          <OpenOrdersForMarket market={market} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header strip
// ---------------------------------------------------------------------------
function TradeHeader({
  ticker,
  strikeDollars,
  spotDollars,
  spotLoading,
  yes,
  no,
  estimated,
  inMoney,
  distPct,
  vol24,
  spread,
  settlesIn,
}: {
  ticker: Ticker;
  strikeDollars: number;
  spotDollars: number | null;
  spotLoading: boolean;
  yes: number | null;
  no: number | null;
  estimated: boolean;
  inMoney: boolean | null;
  distPct: number | null;
  vol24: number;
  spread: number | null;
  settlesIn: string;
}) {
  const spotLabel = spotDollars != null ? fmt$(spotDollars) : spotLoading ? "…" : "—";
  return (
    <Card padding={0} style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr 0.8fr",
          alignItems: "stretch",
        }}
      >
        <div style={{ padding: "20px 24px", borderRight: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span className="label">CONTRACT</span>
            <MarketStatusChip />
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span>{ticker}</span>
            <IconCaret size={18} style={{ color: "var(--accent)" }} />
            <span className="num">${strikeDollars.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 6 }}>
            {TICKER_NAME[ticker]} · spot{" "}
            <span className="num" style={{ color: "var(--text-2)" }}>
              {spotLabel}
            </span>
            {inMoney != null && distPct != null && (
              <span style={{ marginLeft: 8 }} className={inMoney ? "up" : "dn"}>
                {inMoney ? "ITM" : "OTM"} · {(distPct >= 0 ? "+" : "") + distPct.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <HeaderStat
          label="YES"
          value={yes != null ? `${estimated ? "~" : ""}${yes}¢` : "—"}
          aux={yes != null ? (estimated ? "est · no book" : `= ${yes}%`) : "no book"}
          tone="up"
        />
        <HeaderStat
          label="NO"
          value={no != null ? `${estimated ? "~" : ""}${no}¢` : "—"}
          aux={no != null ? (estimated ? "est · no book" : `= ${no}%`) : "no book"}
          tone="dn"
        />
        <HeaderStat
          label="VOL 24H"
          value={vol24.toLocaleString()}
          aux={`${fmtUsdDollars((vol24 * 50) / 100)} notional`}
        />
        <HeaderStat
          label="SPREAD"
          value={spread != null ? `${spread}¢` : "—"}
          aux={spread != null ? `${spread}-tick` : "no book"}
        />
        <div
          style={{
            padding: "20px 18px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "flex-end",
            gap: 4,
          }}
        >
          <span className="label">SETTLES IN</span>
          <div className="num" style={{ fontSize: 18, fontWeight: 500 }}>
            {settlesIn}
          </div>
          <span
            style={{
              fontSize: 10.5,
              fontFamily: "var(--mono)",
              color: "var(--text-3)",
            }}
          >
            4:00 PM ET
          </span>
        </div>
      </div>
    </Card>
  );
}

function HeaderStat({
  label,
  value,
  aux,
  tone,
}: {
  label: string;
  value: string;
  aux: string;
  tone?: "up" | "dn";
}) {
  const color =
    tone === "up" ? "var(--up)" : tone === "dn" ? "var(--down)" : "var(--text)";
  return (
    <div
      style={{
        padding: "20px 18px",
        borderRight: "1px solid var(--line-soft)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
      }}
    >
      <span className="label">{label}</span>
      <span
        className="num"
        style={{ fontSize: 22, fontWeight: 600, color, lineHeight: 1 }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 11,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
        }}
      >
        {aux}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strike chain (left rail)
// ---------------------------------------------------------------------------
function StrikeChain({
  ticker,
  strike,
  spotDollars,
  strikes,
  loading,
}: {
  ticker: Ticker;
  strike: number;
  spotDollars: number | null;
  strikes: StrikeRow[];
  loading: boolean;
}) {
  // ATM = closest strike to spot (only when we have a real spot).
  const atm = useMemo(() => {
    if (strikes.length === 0 || spotDollars == null) return null;
    let best = strikes[0]!.strike;
    let bestDist = Math.abs(spotDollars * 100 - best);
    for (const s of strikes) {
      const d = Math.abs(spotDollars * 100 - s.strike);
      if (d < bestDist) {
        best = s.strike;
        bestDist = d;
      }
    }
    return best;
  }, [strikes, spotDollars]);

  return (
    <Card padding={0} style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--line-soft)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span className="label">Strike chain</span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          {loading && strikes.length === 0 ? "loading…" : `${strikes.length} active`}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr 1fr 1fr",
          padding: "8px 12px",
          borderBottom: "1px solid var(--line-soft)",
          gap: 8,
        }}
      >
        <span className="label" style={{ fontSize: 10 }}>
          K
        </span>
        <span className="label" style={{ fontSize: 10, textAlign: "right" }}>
          YES
        </span>
        <span className="label" style={{ fontSize: 10, textAlign: "right" }}>
          NO
        </span>
        <span className="label" style={{ fontSize: 10, textAlign: "right" }}>
          VOL
        </span>
      </div>

      <div>
        {strikes.length === 0 && (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--text-3)",
              fontSize: 12,
            }}
          >
            {loading ? "Loading strikes from chain…" : "No active strikes on-chain."}
          </div>
        )}
        {[...strikes].reverse().map((c) => {
          const sel = c.strike === strike;
          const isAtm = c.strike === atm;
          return (
            <Link
              key={c.strike}
              href={`/trade/${ticker}/${c.strike}`}
              className="row-hover"
              style={{
                width: "100%",
                padding: "9px 12px",
                background: sel ? "var(--accent-soft)" : "transparent",
                borderLeft: sel ? "2px solid var(--accent)" : "2px solid transparent",
                display: "grid",
                gridTemplateColumns: "auto 1fr 1fr 1fr",
                gap: 8,
                alignItems: "center",
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--text)",
                textAlign: "left",
                textDecoration: "none",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    color: sel ? "var(--accent)" : "var(--text-2)",
                    fontWeight: sel ? 600 : 400,
                  }}
                >
                  ${(c.strike / 100).toFixed(0)}
                </span>
                {isAtm && <StrikePill tone="atm">ATM</StrikePill>}
              </span>
              <span style={{ textAlign: "right", color: "var(--up)" }}>
                {c.yesCents}¢{c.estimated ? "*" : ""}
              </span>
              <span style={{ textAlign: "right", color: "var(--down)" }}>
                {c.noCents}¢{c.estimated ? "*" : ""}
              </span>
              <span
                style={{ textAlign: "right", color: "var(--text-3)", fontSize: 11 }}
              >
                {c.volume > 0 ? c.volume.toLocaleString() : "—"}
              </span>
            </Link>
          );
        })}
      </div>
      {strikes.some((s) => s.estimated) && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 10,
            color: "var(--text-4)",
            fontFamily: "var(--mono)",
            borderTop: "1px solid var(--line-soft)",
          }}
        >
          * estimate (no resting book) — from oracle spot vs strike
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Order book (center)
// ---------------------------------------------------------------------------
function OrderBook({
  bids,
  asks,
  yes,
  spread,
}: {
  bids: Order[];
  asks: Order[];
  yes: number;
  spread: number;
}) {
  const [side, setSide] = useState<"yes" | "no">("yes");
  const max = Math.max(
    1,
    ...asks.map((o) => o.size),
    ...bids.map((o) => o.size),
  );

  const inv = side === "no";
  const dispAsks = inv
    ? [...bids]
        .slice(0, 5)
        .reverse()
        .map((o) => ({ ...o, price: 100 - o.price }))
    : asks.slice(0, 5).reverse();
  const dispBids = inv
    ? [...asks].slice(0, 5).map((o) => ({ ...o, price: 100 - o.price }))
    : bids.slice(0, 5);
  const mid = inv ? 100 - yes : yes;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px 8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h4>Book</h4>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            One book · two perspectives
          </span>
        </div>
        <Seg
          options={[
            { value: "yes" as const, label: "Yes" },
            { value: "no" as const, label: "No" },
          ]}
          value={side}
          onChange={setSide}
        />
      </div>

      <div style={{ padding: "0 18px 18px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            padding: "6px 0",
            borderBottom: "1px solid var(--line-soft)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-3)",
          }}
        >
          <span>Price</span>
          <span style={{ textAlign: "right" }}>Size</span>
          <span style={{ textAlign: "right" }}>Implied prob</span>
        </div>

        {dispAsks.map((o, i) => (
          <BookRow key={`a-${i}`} px={o.price} size={o.size} max={max} side="ask" />
        ))}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 18px",
            background: "var(--bg-elev-2)",
            margin: "4px -18px",
            fontFamily: "var(--mono)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-3)" }}>Spread</span>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: "var(--text)" }}>{spread}¢</span>
            <span style={{ color: "var(--text-3)" }}>mid {mid}¢</span>
          </span>
        </div>

        {dispBids.map((o, i) => (
          <BookRow key={`b-${i}`} px={o.price} size={o.size} max={max} side="bid" />
        ))}

        {dispAsks.length === 0 && dispBids.length === 0 && (
          <div
            style={{
              padding: 24,
              color: "var(--text-3)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            Book is empty — be the first to quote.
          </div>
        )}
      </div>
    </div>
  );
}

function BookRow({
  px,
  size,
  max,
  side,
}: {
  px: number;
  size: number;
  max: number;
  side: "ask" | "bid";
}) {
  const pct = (size / max) * 100;
  const color = side === "ask" ? "var(--down)" : "var(--up)";
  const bg = side === "ask" ? "var(--down-soft)" : "var(--up-soft)";
  return (
    <div
      className="row-hover"
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        padding: "5px 0",
        fontFamily: "var(--mono)",
        fontSize: 12.5,
      }}
    >
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: `${pct}%`,
          background: bg,
          opacity: 0.7,
          pointerEvents: "none",
        }}
      />
      <span style={{ color, position: "relative" }}>{px}¢</span>
      <span style={{ color: "var(--text)", textAlign: "right", position: "relative" }}>
        {size}
      </span>
      <span
        style={{ color: "var(--text-3)", textAlign: "right", position: "relative" }}
      >
        {px}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intraday chart — ILLUSTRATIVE shape anchored to the REAL oracle spot.
//
// This is NOT a live tick feed: Meridian's on-chain OracleAccount publishes a
// single close-relevant price, not an intraday tape. We draw an illustrative
// curve that converges to the real current spot and clearly label it as such
// (no "Pyth feed" claim). When spot is unknown we render a placeholder.
// ---------------------------------------------------------------------------
function IntradayChart({
  ticker,
  spotDollars,
  strikeDollars,
}: {
  ticker: Ticker;
  spotDollars: number | null;
  strikeDollars: number;
}) {
  const tape = useMemo(() => {
    if (spotDollars == null) return [];
    const n = 90;
    const out: number[] = [];
    const prev = spotDollars * 0.998;
    const target = spotDollars;
    let p = prev;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const goal = prev + (target - prev) * t;
      p += (goal - p) * 0.3 + (Math.sin(i * 0.7) * spotDollars * 0.0015);
      out.push(p);
    }
    return out;
  }, [ticker, spotDollars]);

  if (spotDollars == null || tape.length === 0) {
    return (
      <div
        style={{
          padding: 48,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        Waiting for live oracle spot…
      </div>
    );
  }

  const min = Math.min(...tape, strikeDollars) - spotDollars * 0.005;
  const max = Math.max(...tape, strikeDollars) + spotDollars * 0.005;
  const W = 720;
  const H = 260;
  const padL = 50;
  const padR = 14;
  const padT = 24;
  const padB = 30;
  const xAt = (i: number) => padL + (i / (tape.length - 1)) * (W - padL - padR);
  const yAt = (p: number) =>
    H - padB - ((p - min) / (max - min)) * (H - padT - padB);
  const d = "M" + tape.map((p, i) => `${xAt(i)},${yAt(p)}`).join(" L");
  const dArea = `${d} L${xAt(tape.length - 1)},${yAt(min)} L${xAt(0)},${yAt(min)} Z`;
  const lastY = yAt(tape[tape.length - 1]!);

  const times = ["9:30", "10:30", "11:30", "12:30", "1:30", "2:14"];

  return (
    <div style={{ padding: "18px 14px 18px 4px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 14px 12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h4>{ticker} intraday</h4>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            illustrative · anchored to live oracle spot (not a live tick feed)
          </span>
        </div>
        <span
          className="pill"
          style={{
            background: "var(--accent-soft)",
            color: "var(--accent)",
            borderColor: "var(--accent-line)",
          }}
        >
          K = ${strikeDollars.toFixed(0)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <defs>
          <linearGradient id="ifill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={padL}
            x2={W - padR}
            y1={padT + p * (H - padT - padB)}
            y2={padT + p * (H - padT - padB)}
            stroke="var(--line-soft)"
            strokeDasharray="2 3"
          />
        ))}
        <line
          x1={padL}
          x2={W - padR}
          y1={yAt(strikeDollars)}
          y2={yAt(strikeDollars)}
          stroke="var(--accent)"
          strokeDasharray="4 3"
          strokeWidth="1.5"
        />
        <text
          x={padL + 6}
          y={yAt(strikeDollars) - 6}
          fill="var(--accent)"
          fontFamily="var(--mono)"
          fontSize="10"
        >
          K = ${strikeDollars.toFixed(2)}
        </text>
        <path d={dArea} fill="url(#ifill)" />
        <path d={d} stroke="var(--text)" strokeWidth="1.5" fill="none" />
        <circle cx={xAt(tape.length - 1)} cy={lastY} r="4" fill="var(--accent)" />
        <circle
          cx={xAt(tape.length - 1)}
          cy={lastY}
          r="9"
          fill="var(--accent)"
          opacity="0.2"
        />
        {[min, (min + max) / 2, max].map((p, i) => (
          <text
            key={i}
            x={padL - 6}
            y={yAt(p) + 3}
            textAnchor="end"
            fill="var(--text-3)"
            fontFamily="var(--mono)"
            fontSize="10"
          >
            ${p.toFixed(2)}
          </text>
        ))}
        {times.map((t, i) => (
          <text
            key={i}
            x={padL + (i / (times.length - 1)) * (W - padL - padR)}
            y={H - 8}
            textAnchor={
              i === 0 ? "start" : i === times.length - 1 ? "end" : "middle"
            }
            fill="var(--text-3)"
            fontFamily="var(--mono)"
            fontSize="10"
          >
            {t}
          </text>
        ))}
        <line x1={padL} x2={padL} y1={padT} y2={H - padB} stroke="var(--line)" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spot vs Strike ladder
// ---------------------------------------------------------------------------
function SpotStrikeLadder({
  spotDollars,
  strikeCents,
  strikes,
}: {
  spotDollars: number | null;
  strikeCents: number;
  strikes: StrikeRow[];
}) {
  if (strikes.length === 0 || spotDollars == null) {
    return (
      <div
        style={{
          padding: 36,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        {spotDollars == null ? "Waiting for live oracle spot…" : "No strikes yet."}
      </div>
    );
  }
  const xs = strikes.map((c) => c.strike / 100);
  const lo = Math.min(...xs, spotDollars) - 5;
  const hi = Math.max(...xs, spotDollars) + 5;
  const W = 720;
  const H = 220;
  const padL = 30;
  const padR = 30;
  const x2 = (v: number) => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
  const prevClose = spotDollars * 0.997;
  const atm = strikes.reduce((best, c) =>
    Math.abs(c.strike - spotDollars * 100) < Math.abs(best.strike - spotDollars * 100)
      ? c
      : best,
  ).strike;

  return (
    <div style={{ padding: "20px 14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          padding: "0 6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h4>Spot on the ladder</h4>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            Live spot relative to the whole strike chain
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <line x1={padL} x2={W - padR} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeWidth="1" />
        {strikes.map((c) => {
          const k = c.strike / 100;
          const cx = x2(k);
          const sel = c.strike === strikeCents;
          const winner = Math.max(c.yesCents, c.noCents);
          return (
            <g key={c.strike}>
              <line
                x1={cx}
                x2={cx}
                y1={H / 2 - 12}
                y2={H / 2 + 12}
                stroke={sel ? "var(--accent)" : "var(--line-strong)"}
                strokeWidth={sel ? 2 : 1}
              />
              <text
                x={cx}
                y={H / 2 + 30}
                textAnchor="middle"
                fontFamily="var(--mono)"
                fontSize="10.5"
                fill={sel ? "var(--accent)" : "var(--text-3)"}
              >
                ${k.toFixed(0)}
              </text>
              <text
                x={cx}
                y={H / 2 - 18}
                textAnchor="middle"
                fontFamily="var(--mono)"
                fontSize="10"
                fill={c.yesCents > 50 ? "var(--up)" : "var(--down)"}
              >
                {winner}¢
              </text>
              <rect
                x={cx - 12}
                y={H / 2 + 38}
                width="24"
                height="4"
                rx="2"
                fill="var(--bg-elev-2)"
              />
              <rect
                x={cx - 12}
                y={H / 2 + 38}
                width={(24 * c.yesCents) / 100}
                height="4"
                rx="2"
                fill="var(--up)"
                opacity="0.8"
              />
              {c.strike === atm && (
                <text
                  x={cx}
                  y={H / 2 + 60}
                  textAnchor="middle"
                  fontFamily="var(--mono)"
                  fontSize="9"
                  fill="var(--accent)"
                  letterSpacing="0.08em"
                >
                  ATM
                </text>
              )}
            </g>
          );
        })}
        {/* Spot needle */}
        <g>
          <line
            x1={x2(spotDollars)}
            x2={x2(spotDollars)}
            y1={H / 2 - 50}
            y2={H / 2 + 16}
            stroke="var(--accent)"
            strokeWidth="2"
          />
          <polygon
            points={`${x2(spotDollars)},${H / 2 - 50} ${x2(spotDollars) - 5},${
              H / 2 - 58
            } ${x2(spotDollars) + 5},${H / 2 - 58}`}
            fill="var(--accent)"
          />
          <text
            x={x2(spotDollars)}
            y={H / 2 - 66}
            textAnchor="middle"
            fontFamily="var(--mono)"
            fontSize="11"
            fill="var(--accent)"
            fontWeight="600"
          >
            spot {fmt$(spotDollars)}
          </text>
        </g>
        {/* Prev close marker */}
        <g>
          <line
            x1={x2(prevClose)}
            x2={x2(prevClose)}
            y1={H / 2 - 4}
            y2={H / 2 + 4}
            stroke="var(--text-3)"
            strokeDasharray="2 2"
          />
          <text
            x={x2(prevClose)}
            y={H / 2 - 70}
            textAnchor="middle"
            fontFamily="var(--mono)"
            fontSize="10"
            fill="var(--text-4)"
          >
            prev {fmt$(prevClose)}
          </text>
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent trades table
// ---------------------------------------------------------------------------
function RecentTradesTable({
  trades,
  mounted,
}: {
  trades: { ts: number; price: number; size: number; side: Side; txSig: string }[];
  mounted: boolean;
}) {
  if (trades.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 12,
        }}
      >
        No recent trades.
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Time</th>
          <th>Side</th>
          <th style={{ textAlign: "right" }}>Price</th>
          <th style={{ textAlign: "right" }}>Size</th>
          <th style={{ textAlign: "right", paddingRight: 24 }}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {trades.slice(0, 9).map((t, i) => (
          <tr key={i}>
            <td className="num" style={{ color: "var(--text-3)" }}>
              {mounted
                ? new Date(t.ts).toLocaleTimeString("en-US", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                : "—"}
            </td>
            <td
              className={t.side === "yes" ? "up" : "dn"}
              style={{
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                fontSize: 12,
              }}
            >
              {t.side}
            </td>
            <td className="num" style={{ textAlign: "right" }}>
              {t.price}¢
            </td>
            <td className="num" style={{ textAlign: "right" }}>
              {t.size}
            </td>
            <td style={{ textAlign: "right", paddingRight: 24, color: "var(--text-3)" }}>
              {t.txSig ? (
                <a
                  href={explorerTx(t.txSig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--text-3)", display: "inline-flex" }}
                >
                  <IconExt size={12} />
                </a>
              ) : (
                <IconExt size={12} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Scenario simulator
// ---------------------------------------------------------------------------
function ScenarioStrip({
  ticker,
  spotDollars,
  strikeDollars,
  holding,
}: {
  ticker: Ticker;
  spotDollars: number | null;
  strikeDollars: number;
  holding: { yes: number; no: number };
}) {
  // Center the slider on the real spot when known, else on the strike.
  const base = spotDollars ?? strikeDollars;
  const min = strikeDollars - base * 0.04;
  const max = strikeDollars + base * 0.04;
  const [close, setClose] = useState(base);
  const yesWin = close >= strikeDollars;
  const hasPos = holding.yes > 0 || holding.no > 0;

  // REAL settlement value (not a guessed swing): each held token settles to
  // exactly $1 if its side wins at `close`, else $0. This is contract-exact.
  function settlementValue(side: Side, qty: number): number {
    if (qty <= 0) return 0;
    const winning = side === "yes" ? yesWin : !yesWin;
    return winning ? qty * 1 : 0;
  }

  return (
    <Card padding={20}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <h4>Scenario simulator</h4>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            Drag to see your P&amp;L
          </span>
        </div>
        <span className="pill">
          If {ticker} closes at{" "}
          <span style={{ color: "var(--text)" }} className="num">
            &nbsp;{fmt$(close)}
          </span>
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 220px",
          gap: 24,
          alignItems: "center",
        }}
      >
        <div>
          <input
            type="range"
            min={min}
            max={max}
            step={0.5}
            value={close}
            onChange={(e) => setClose(parseFloat(e.target.value))}
            style={{
              width: "100%",
              accentColor: yesWin ? "oklch(0.80 0.16 158)" : "oklch(0.72 0.20 25)",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            <span>{fmt$(min, 0)}</span>
            <span style={{ color: "var(--accent)" }}>
              K = ${strikeDollars.toFixed(0)}
            </span>
            <span>{fmt$(max, 0)}</span>
          </div>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <Stat
            k="Yes payout"
            v={yesWin ? "$1.00" : "$0.00"}
            vColor={yesWin ? "var(--up)" : "var(--down)"}
          />
          <Stat
            k="No payout"
            v={!yesWin ? "$1.00" : "$0.00"}
            vColor={!yesWin ? "var(--up)" : "var(--down)"}
          />
          {hasPos && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                background: "var(--bg-elev-2)",
                borderRadius: 6,
              }}
            >
              <div className="label" style={{ marginBottom: 4 }}>
                Your position
              </div>
              {holding.yes > 0 && (
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 13,
                    color: "var(--text)",
                  }}
                >
                  {holding.yes} YES → settles to{" "}
                  <span className={yesWin ? "up" : "dn"}>
                    {fmtUsdDollars(settlementValue("yes", holding.yes))}
                  </span>
                </div>
              )}
              {holding.no > 0 && (
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 13,
                    color: "var(--text)",
                  }}
                >
                  {holding.no} NO → settles to{" "}
                  <span className={!yesWin ? "up" : "dn"}>
                    {fmtUsdDollars(settlementValue("no", holding.no))}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trade panel (right rail) — wired to buildAndSendTrade
// ---------------------------------------------------------------------------
function TradePanel({
  ticker,
  strikeCents,
  strikeDollars,
  yes,
  no,
  estimated,
  book,
  holding,
  settled,
  outcome,
}: {
  ticker: Ticker;
  strikeCents: number;
  strikeDollars: number;
  yes: number | null;
  no: number | null;
  estimated: boolean;
  book: { bids: Order[]; asks: Order[] } | null;
  holding: { yes: number; no: number };
  /** True once the market is settled — order entry is disabled (place_order
   *  reverts AlreadySettled), mint/redeem stay available elsewhere. */
  settled: boolean;
  /** Winning side once settled, for the read-only summary. */
  outcome: Outcome | null;
}) {
  const mounted = useMounted();
  const wallet = useWallet();
  const { connection } = useConnection();
  const walletModal = useWalletModal();
  const connected = mounted && wallet.connected;
  const usdc = useUsdcBalance();
  const [settings] = useSettings();

  // When the book is empty there's no live mid; show a neutral 50¢ as the
  // display anchor (clearly the user can still place a limit order to quote).
  const yesPx = yes ?? 50;
  const noPx = no ?? 50;

  // Trading-window gate (US equity session). Mint/redeem stay enabled; only
  // the order-placement submit is gated. SSR-safe via useMounted.
  // On mainnet this HARD-blocks trading outside 9:30 AM–4:00 PM ET. On devnet
  // (the demo cluster) we still surface the closed-session notice for honesty,
  // but keep trading enabled so the deployment is fully interactive any time.
  const sessionOpen = !mounted || marketStatus() === "open";
  const isDevnet = env.cluster !== "mainnet-beta";
  // A SETTLED market hard-disables order entry regardless of cluster/session:
  // place_order reverts AlreadySettled on-chain, so we never submit into a
  // guaranteed revert. Mint/redeem live elsewhere and stay available.
  const tradingAllowed = !settled && (sessionOpen || isDevnet);

  const [side, setSide] = useState<Side>("yes");
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [qtyStr, setQtyStr] = useState("10");
  const [limitStr, setLimitStr] = useState(String(yesPx));
  const [submitting, setSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showConstraint, setShowConstraint] = useState(false);

  const qty = Math.max(0, Math.floor(Number(qtyStr) || 0));
  const limit = Math.max(1, Math.min(99, Number(limitStr) || yesPx));

  const bestBid = book?.bids[0]?.price ?? yesPx - 1;
  const bestAsk = book?.asks[0]?.price ?? yesPx + 1;

  const effectiveYesPx =
    orderType === "limit"
      ? limit
      : action === "buy"
        ? side === "yes"
          ? bestAsk
          : 100 - bestBid
        : side === "yes"
          ? bestBid
          : 100 - bestAsk;
  const effectivePx = side === "yes" ? effectiveYesPx : 100 - effectiveYesPx;
  const cost = (effectivePx * qty) / 100;
  // Parabolic taker fee — evaluated at the yes price of the executing trade,
  // matching the contract's compute_taker_fee(notional, maker_price).
  const feeBps = takerFeeBps(effectiveYesPx);
  const fee = takerFeeDollars(cost, effectiveYesPx);
  const maxPayout = qty;
  // Net profit if the position wins: $1/token payout minus what you paid (cost + fee).
  const maxProfit = maxPayout - cost - fee;
  const probBefore = side === "yes" ? yesPx : noPx;
  const probAfter = Math.min(99, probBefore + Math.ceil(qty / 50));
  const requiredUsdcCents = Math.ceil((cost + fee) * 100);
  const insufficient =
    action === "buy" && usdc.cents != null && requiredUsdcCents > usdc.cents;

  function handleSubmit() {
    if (!connected) {
      walletModal.setVisible(true);
      return;
    }
    if (settled) {
      notify.warning("Market resolved — trading is closed. Redeem winning tokens for $1 each.");
      return;
    }
    if (!tradingAllowed) {
      notify.warning("Market closed — trading is 9:30 AM–4:00 PM ET");
      return;
    }
    if (qty <= 0) {
      notify.warning("Enter a quantity > 0");
      return;
    }
    if (action === "buy") {
      if (side === "yes" && holding.no > 0) {
        setShowConstraint(true);
        return;
      }
      if (side === "no" && holding.yes > 0) {
        setShowConstraint(true);
        return;
      }
    }
    if (settings.confirmTradeModal && settings.tradesCompleted < 3) {
      setShowConfirm(true);
      return;
    }
    void executeTrade();
  }

  async function executeTrade() {
    const args: BuildTradeArgs = {
      ticker,
      strike: strikeCents,
      side,
      intent: action,
      orderType,
      quantity: qty,
      limitPriceCents: orderType === "limit" ? limit : undefined,
      slippageBps: settings.slippageBps,
    };
    setSubmitting(true);
    try {
      const res = await buildAndSendTrade(connection, wallet, args);
      bumpTradeCount();
      // Report what actually happened: crossed fills vs a resting limit order.
      // (filledSize/restingSize are populated for direct YES trades; the NO-side
      // composite flows leave them undefined → fall back to the requested qty.)
      const filled = res.filledSize ?? qty;
      const resting = res.restingSize ?? 0;
      const sideLabel = side.toUpperCase();
      const verb = action === "buy" ? "Bought" : "Sold";
      if (filled > 0 && resting > 0) {
        notify.success(
          `${verb} ${filled} ${sideLabel} @ ${res.avgFillCents}¢ · ${resting} resting on the book`,
        );
      } else if (filled > 0) {
        notify.success(`${verb} ${filled} ${sideLabel} · avg ${res.avgFillCents}¢`);
      } else if (resting > 0) {
        notify.success(
          `Limit order placed · ${resting} ${sideLabel} resting @ ${res.avgFillCents}¢`,
        );
      } else {
        notify.success(`${verb} ${qty} ${sideLabel} · avg ${res.avgFillCents}¢`);
      }
      notify.info(`Tx: ${res.signature.slice(0, 16)}…`);
    } catch (err) {
      notify.error(
        `Trade failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      setSubmitting(false);
      setShowConfirm(false);
    }
  }

  return (
    <>
      <Card padding={18} style={{ position: "sticky", top: 80, alignSelf: "start" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div>
            <h4>Trade {ticker}</h4>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>
              Strike ${strikeDollars.toFixed(2)} · {TICKER_NAME[ticker]}
            </span>
          </div>
          <Pill>SOL Devnet</Pill>
        </div>

        {/* SIDE — yes/no big cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
            marginBottom: 6,
          }}
        >
          <button
            type="button"
            onClick={() => setSide("yes")}
            style={{
              padding: "12px 8px",
              background: side === "yes" ? "var(--up-soft)" : "transparent",
              border: `1px solid ${side === "yes" ? "var(--up-line)" : "var(--line-soft)"}`,
              color: side === "yes" ? "var(--up)" : "var(--text-3)",
              borderRadius: 8,
              cursor: "pointer",
              textAlign: "center",
              fontFamily: "var(--sans)",
              fontWeight: 600,
              fontSize: 13,
              transition: "all .12s",
            }}
          >
            <div className="label" style={{ color: "inherit", opacity: 0.7 }}>
              YES · closes ≥ ${strikeDollars.toFixed(0)}
            </div>
            <div className="num" style={{ fontSize: 20, marginTop: 4 }}>
              {yes != null ? `${estimated ? "~" : ""}${yes}¢` : "—"}
            </div>
          </button>
          <button
            type="button"
            onClick={() => setSide("no")}
            style={{
              padding: "12px 8px",
              background: side === "no" ? "var(--down-soft)" : "transparent",
              border: `1px solid ${side === "no" ? "var(--down-line)" : "var(--line-soft)"}`,
              color: side === "no" ? "var(--down)" : "var(--text-3)",
              borderRadius: 8,
              cursor: "pointer",
              textAlign: "center",
              fontFamily: "var(--sans)",
              fontWeight: 600,
              fontSize: 13,
              transition: "all .12s",
            }}
          >
            <div className="label" style={{ color: "inherit", opacity: 0.7 }}>
              NO · closes &lt; ${strikeDollars.toFixed(0)}
            </div>
            <div className="num" style={{ fontSize: 20, marginTop: 4 }}>
              {no != null ? `${estimated ? "~" : ""}${no}¢` : "—"}
            </div>
          </button>
        </div>

        {settled && (
          <div
            style={{
              marginTop: 10,
              padding: "10px 12px",
              border: `1px solid ${outcome === "yes" ? "var(--up-line)" : "var(--down-line)"}`,
              borderRadius: 6,
              background: outcome === "yes" ? "var(--up-soft)" : "var(--down-soft)",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--text-2)",
            }}
          >
            {outcome ? (
              <>
                Resolved ·{" "}
                <strong style={{ color: outcome === "yes" ? "var(--up)" : "var(--down)" }}>
                  {outcome === "yes" ? "Yes won" : "No won"}
                </strong>
                . Trading is closed; winning tokens redeem for $1 each in your
                portfolio.
              </>
            ) : (
              <>Awaiting settlement — this market has expired and is being resolved.</>
            )}
          </div>
        )}

        {!settled && estimated && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              border: "1px solid var(--line-soft)",
              borderRadius: 6,
              background: "var(--bg-elev-2)",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
            }}
          >
            ~ estimated price (no resting book). Nobody is quoting this strike yet,
            so a <strong style={{ color: "var(--text-2)" }}>market order can&apos;t fill</strong>
            {" "}— place a <strong style={{ color: "var(--text-2)" }}>limit order</strong> to
            set your price and make the market.
          </div>
        )}

        {/* ACTION — buy/sell */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            marginTop: 10,
          }}
        >
          {(["buy", "sell"] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAction(a)}
              style={{
                padding: "8px 0",
                background: action === a ? "var(--bg-elev-2)" : "transparent",
                border: 0,
                color: action === a ? "var(--text)" : "var(--text-3)",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 500,
                fontSize: 13,
                borderBottom:
                  action === a
                    ? `2px solid var(--${side === "yes" ? "up" : "down"})`
                    : "2px solid transparent",
              }}
            >
              {a === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>

        {/* ORDER TYPE */}
        <div style={{ marginTop: 14 }}>
          <Seg
            options={[
              { value: "market" as const, label: "Market" },
              { value: "limit" as const, label: "Limit" },
            ]}
            value={orderType}
            onChange={setOrderType}
          />
        </div>

        {/* INPUTS */}
        <div style={{ marginTop: 14 }}>
          <Label style={{ marginBottom: 6 }}>Quantity (tokens)</Label>
          <div style={{ position: "relative" }}>
            <input
              type="number"
              className="field"
              value={qtyStr}
              onChange={(e) => setQtyStr(e.target.value)}
            />
            <div
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                gap: 2,
              }}
            >
              {[10, 50, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setQtyStr(String(v))}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    background: "var(--bg-elev-2)",
                    border: 0,
                    color: "var(--text-3)",
                    borderRadius: 4,
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {orderType === "limit" && (
            <div style={{ marginTop: 10 }}>
              <Label style={{ marginBottom: 6 }}>Limit price (¢)</Label>
              <input
                type="number"
                className="field"
                min={1}
                max={99}
                value={limitStr}
                onChange={(e) => setLimitStr(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* SUMMARY */}
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "var(--bg)",
            borderRadius: 8,
            border: "1px solid var(--line-soft)",
          }}
        >
          <Stat k="Avg fill" v={`${effectivePx}¢`} />
          <Stat k="Quantity" v={qty.toLocaleString()} />
          <Stat k="Cost" v={fmtUsdDollars(cost)} />
          <Stat k={`Fee (${(feeBps / 100).toFixed(2)}%)`} v={fmtUsdDollars(fee)} />
          <Stat
            k={`Max payout if ${side.toUpperCase()} wins`}
            v={fmtUsdDollars(maxPayout)}
            vColor="var(--up)"
          />
          <Stat
            k={`Max profit if ${side.toUpperCase()} wins`}
            v={fmtUsdDollars(maxProfit)}
            vColor="var(--up)"
          />
          <div
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--line-soft)",
            }}
          >
            <Stat k="Implied prob" v={`${probBefore}% → ${probAfter}%`} />
          </div>
        </div>

        {/* PAYOFF MESSAGE */}
        <div
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: side === "yes" ? "var(--up-soft)" : "var(--down-soft)",
            borderRadius: 6,
            borderLeft: `2px solid ${side === "yes" ? "var(--up)" : "var(--down)"}`,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
            You pay{" "}
            <span className="num" style={{ color: "var(--text)" }}>
              {fmtUsdDollars(cost + fee)}
            </span>
            . You win{" "}
            <span className="num" style={{ color: "var(--text)" }}>
              {fmtUsdDollars(maxPayout)}
            </span>{" "}
            if {ticker} closes {side === "yes" ? "above" : "below"} $
            {strikeDollars.toFixed(2)}.
          </div>
        </div>

        {/* CTA */}
        {settled ? (
          <Link
            href="/portfolio"
            className="btn lg"
            style={{
              width: "100%",
              marginTop: 12,
              display: "flex",
              justifyContent: "center",
              textDecoration: "none",
            }}
          >
            Market resolved · Redeem in portfolio
          </Link>
        ) : !connected ? (
          <Button
            primary
            lg
            style={{ width: "100%", marginTop: 12 }}
            onClick={() => walletModal.setVisible(true)}
          >
            Connect wallet to trade
          </Button>
        ) : !tradingAllowed ? (
          <Button disabled lg style={{ width: "100%", marginTop: 12 }}>
            Market closed
          </Button>
        ) : orderType === "market" && estimated ? (
          <Button
            lg
            style={{ width: "100%", marginTop: 12 }}
            onClick={() => setOrderType("limit")}
          >
            No liquidity — switch to Limit
          </Button>
        ) : insufficient ? (
          <Button disabled lg style={{ width: "100%", marginTop: 12 }}>
            Insufficient USDC
          </Button>
        ) : (
          <Button
            primary
            lg
            style={{ width: "100%", marginTop: 12 }}
            onClick={handleSubmit}
            disabled={submitting || qty <= 0}
          >
            {submitting
              ? "Submitting…"
              : `${action === "buy" ? "Buy" : "Sell"} ${side.toUpperCase()} · ${fmtUsdDollars(cost)}`}
          </Button>
        )}

        {connected && !sessionOpen && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              border: "1px solid var(--line-soft)",
              borderRadius: 6,
              background: "var(--down-soft)",
              fontSize: 11.5,
              color: "var(--down)",
              fontFamily: "var(--mono)",
              textAlign: "center",
            }}
          >
            {isDevnet
              ? "US session closed (9:30 AM–4:00 PM ET). Devnet demo trading stays enabled."
              : "Market closed — trading is 9:30 AM–4:00 PM ET. Mint/redeem stay open."}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 10,
            fontSize: 10.5,
            color: "var(--text-4)",
            fontFamily: "var(--mono)",
          }}
        >
          <span>
            Best bid {bestBid}¢ · Best ask {bestAsk}¢
          </span>
          <span>On-chain CLOB</span>
        </div>

        {(holding.yes > 0 || holding.no > 0) && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              border: "1px solid var(--line-soft)",
              borderRadius: 6,
              background: "var(--bg)",
              fontSize: 11,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
            }}
          >
            You hold {holding.yes} YES · {holding.no} NO on this strike.
          </div>
        )}
      </Card>

      {showConfirm && (
        <ConfirmTradeModal
          ticker={ticker}
          strike={strikeCents}
          side={side}
          intent={action}
          quantity={qty}
          avgFillCents={effectiveYesPx}
          feeBps={feeBps}
          onConfirm={() => {
            setShowConfirm(false);
            void executeTrade();
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {showConstraint && (
        <PositionConstraintModal
          ticker={ticker}
          strike={strikeCents}
          existingSide={side === "yes" ? "no" : "yes"}
          existingQuantity={side === "yes" ? holding.no : holding.yes}
          newSide={side}
          newQuantity={qty}
          limitPriceCents={orderType === "limit" ? limit : undefined}
          onClose={() => setShowConstraint(false)}
          onComplete={() => {
            setShowConstraint(false);
            bumpTradeCount();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resolved banner (read-only, after-hours)
// ---------------------------------------------------------------------------
function ResolvedBanner({
  ticker,
  strikeDollars,
  outcome,
  settlementDollars,
  settledAtLabel,
}: {
  ticker: Ticker;
  strikeDollars: number;
  outcome: Outcome | null;
  settlementDollars: number | null;
  settledAtLabel: string | null;
}) {
  const yesWon = outcome === "yes";
  const tone = outcome ? (yesWon ? "up" : "down") : null;
  return (
    <Card
      padding={0}
      style={{
        overflow: "hidden",
        marginTop: 12,
        borderColor: tone ? `var(--${tone}-line)` : "var(--line-soft)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          padding: "14px 18px",
          background: tone ? `var(--${tone}-soft)` : "var(--bg-elev-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            className="pill"
            style={{
              background: tone ? `var(--${tone}-soft)` : "var(--bg-elev)",
              color: tone ? `var(--${tone})` : "var(--text-3)",
              borderColor: tone ? `var(--${tone}-line)` : "var(--line-soft)",
              fontWeight: 600,
            }}
          >
            {outcome ? `Resolved · ${yesWon ? "Yes" : "No"} won` : "Awaiting settlement"}
          </span>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            {ticker} ${strikeDollars.toFixed(2)} ·{" "}
            {outcome
              ? `${yesWon ? "Closed at or above" : "Closed below"} the strike. Trading is closed — read-only.`
              : "This market has expired and is being settled. Trading is closed."}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 20,
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--text-3)",
          }}
        >
          <span>
            Settle close{" "}
            <span style={{ color: "var(--text)" }}>
              {settlementDollars != null ? fmt$(settlementDollars) : "—"}
            </span>
          </span>
          <span>
            Settled{" "}
            <span style={{ color: "var(--text)" }}>{settledAtLabel ?? "—"}</span>
          </span>
          <Link
            href="/portfolio"
            className="btn sm"
            style={{ textDecoration: "none" }}
          >
            Redeem in portfolio
          </Link>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function settlesInLabel(expiryTs: number | null): string {
  if (expiryTs == null) return "—";
  const ms = expiryTs * 1000 - Date.now();
  if (ms <= 0) return "0m";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// DEV (localnet only): re-roll this strike to a fresh future expiry so it stays
// a non-expired, tradeable market past the 0DTE close — for continuing a demo
// after 4 PM ET. Hidden on devnet/mainnet. create_strike_market isn't
// admin-gated, so the connected funded wallet can do it.
// ---------------------------------------------------------------------------
function DevReRollButton({ ticker, strike }: { ticker: Ticker; strike: number }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const isLocalnet =
    (env.rpcUrl || "").includes("localhost") || (env.rpcUrl || "").includes("127.0.0.1");
  if (!isLocalnet) return null;

  async function handle() {
    if (!wallet.connected || !wallet.publicKey) {
      notify.warning("Connect a funded demo wallet first.");
      return;
    }
    setBusy(true);
    try {
      const r = await reRollStrike(connection, wallet, ticker, strike);
      notify.success(
        r.created
          ? `Re-rolled ${ticker} $${(strike / 100).toFixed(2)} → fresh market expiring ${new Date(
              r.expiryTs * 1000,
            ).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" })}. Keep trading.`
          : `${ticker} $${(strike / 100).toFixed(2)} already has a fresh market at that expiry.`,
      );
    } catch (e) {
      notify.error(`Re-roll failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handle()}
      disabled={busy}
      title="DEV (localnet): create a fresh future-dated market for this strike so you can keep trading past the 0DTE close"
      style={{
        marginLeft: 8,
        padding: "2px 8px",
        fontSize: 10,
        fontFamily: "var(--mono)",
        background: "var(--bg-elev)",
        border: "1px dashed var(--line-soft)",
        borderRadius: 999,
        color: "var(--text-3)",
        cursor: "pointer",
      }}
    >
      {busy ? "re-rolling…" : "↻ re-roll (dev)"}
    </button>
  );
}
