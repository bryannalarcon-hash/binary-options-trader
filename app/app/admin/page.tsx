"use client";

/**
 * Meridian admin / dev-tools panel — `/admin`.
 *
 * Operator console to drive the on-chain lifecycle without the CLI:
 *   1. Status banner   — connected wallet vs config.admin / oracle_authority,
 *                        paused state.
 *   2. Oracle control  — per-ticker on-chain price + push a new price, plus a
 *                        "Refresh all from Pyth" that pulls live Hermes prices.
 *   3. Settlement      — list markets, settle one / settle all open.
 *   4. Market creation — create today's ±3/6/9% strike grid (idempotent).
 *   5. Pause / unpause — global toggle.
 *
 * Everything is REAL on-chain via the connected wallet (`useWallet()`).
 * The page self-gates: it always renders, but admin-only actions revert on
 * the contract when the wallet isn't the admin / oracle authority.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import {
  Card,
  SectionTitle,
  Button,
  Pill,
  StrikePill,
  Label,
  Stat,
  IconBolt,
  IconRefresh,
  IconClock,
  IconPyth,
  IconCheckCircle,
  IconXCircle,
  IconAlert,
  IconExt,
} from "@/components/caret";
import { useAllMarkets } from "@/lib/markets-client";
import { useMounted } from "@/lib/use-mounted";
import { notify } from "@/lib/notify";
import { explorerTx, explorerAddress } from "@/lib/explorer";
import { shortKey } from "@/lib/format";
import { MAG7_TICKERS, TICKER_NAME, type Ticker } from "@/lib/tickers";
import type { Market } from "@meridian/types";
import {
  readConfig,
  readAllOracles,
  pushOraclePrice,
  fetchHermesMag7,
  settleMarket,
  setPaused,
  createTodaysMarketsForTicker,
  addSyntheticStrike,
  todayExpiryTsSeconds,
  type ConfigState,
  type OracleState,
} from "@/lib/admin-tx";
import { nextTradingDayExpiryTs } from "@/lib/market-hours";

/** Hard-coded reference admin pubkey (for the "import keys/admin.json" hint). */
const ADMIN_PUBKEY = "6GQwLJDFmwdjngnKBXV5K6e5i7zM4ufHnwxyUvXeZayM";

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Surface a settle / oracle error with a helpful hint. */
function reportTxError(label: string, err: unknown): void {
  const m = errMsg(err);
  const lower = m.toLowerCase();
  if (lower.includes("oraclestale") || lower.includes("too stale") || lower.includes("0x1776")) {
    notify.error(`${label} failed: oracle is stale. Push a fresh price for this ticker first.`);
  } else if (lower.includes("confidence") || lower.includes("0x1777")) {
    notify.error(`${label} failed: oracle confidence band too wide. Push a price with tight conf.`);
  } else if (lower.includes("adminrequired") || lower.includes("0x1778")) {
    notify.error(`${label} failed: admin signer required. Connect the admin wallet.`);
  } else if (lower.includes("invalidoracleauthority") || lower.includes("0x1784")) {
    notify.error(`${label} failed: wallet is not the oracle authority.`);
  } else if (lower.includes("timegate") || lower.includes("0x1779")) {
    notify.error(`${label} failed: time gate not elapsed (settle only after expiry).`);
  } else if (lower.includes("alreadysettled") || lower.includes("0x1771")) {
    notify.warning(`${label}: market already settled.`);
  } else {
    notify.error(`${label} failed: ${m}`);
  }
}

export default function AdminPage() {
  const mounted = useMounted();
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletModal = useWalletModal();
  const { markets } = useAllMarkets();

  const [config, setConfig] = useState<ConfigState | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [oracles, setOracles] = useState<OracleState[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const connected = mounted && wallet.connected && !!wallet.publicKey;
  const myKey = mounted && wallet.publicKey ? wallet.publicKey.toBase58() : null;
  const isAdmin = !!(config && myKey && myKey === config.admin);
  const isOracleAuth = !!(config && myKey && myKey === config.oracleAuthority);

  // --- Reads: config + oracles -------------------------------------------
  const reloadConfig = useCallback(async () => {
    setConfigLoading(true);
    const c = await readConfig(connection);
    setConfig(c);
    setConfigLoading(false);
  }, [connection]);

  const reloadOracles = useCallback(async () => {
    const o = await readAllOracles(connection);
    setOracles(o);
  }, [connection]);

  useEffect(() => {
    void reloadConfig();
    void reloadOracles();
    const id = window.setInterval(() => {
      void reloadConfig();
      void reloadOracles();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [reloadConfig, reloadOracles, refreshKey]);

  function refreshAll() {
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="page">
      {/* HEADER */}
      <header
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
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--accent)",
              }}
            >
              <IconBolt size={11} aria-hidden /> Operator tools
            </span>
          </Label>
          <h2 style={{ marginTop: 6 }}>Operator Console</h2>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-3)", maxWidth: 640 }}>
            Drive the on-chain lifecycle — oracle, settlement, market creation,
            pause. All actions are real transactions signed by your wallet.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {config && (
            <Pill tone={config.paused ? "dn" : "up"}>
              <span className="dot" />
              {config.paused ? "Paused" : "Active"}
            </Pill>
          )}
          <Button
            sm
            ghost
            onClick={refreshAll}
            leftIcon={<IconRefresh size={13} aria-hidden />}
            aria-label="Refresh on-chain reads"
          >
            Refresh
          </Button>
        </div>
      </header>

      {/* STATUS BANNER */}
      <StatusBanner
        connected={connected}
        myKey={myKey}
        config={config}
        configLoading={configLoading}
        isAdmin={isAdmin}
        isOracleAuth={isOracleAuth}
        onConnect={() => walletModal.setVisible(true)}
      />

      {/* ── ORACLE ───────────────────────────────────────────────── */}
      <GroupHeading
        title="Oracle"
        purpose="On-chain settlement prices per ticker. Settlement reads these — keep them fresh."
      />
      <OracleControl
        oracles={oracles}
        canPush={connected}
        onPush={async (ticker, priceCents) => {
          try {
            const sig = await pushOraclePrice(connection, wallet, {
              ticker,
              priceCents,
            });
            notify.success(
              `Pushed ${ticker} @ $${(priceCents / 100).toFixed(2)} — ${shortKey(sig)}`,
            );
            await reloadOracles();
          } catch (err) {
            reportTxError(`Push ${ticker} price`, err);
          }
        }}
        onRefreshAllPyth={async () => {
          if (!connected) {
            notify.warning("Connect a wallet to push prices.");
            return;
          }
          try {
            notify.info("Fetching live MAG7 prices from Pyth Hermes…");
            const prices = await fetchHermesMag7();
            if (prices.size === 0) {
              notify.error("Hermes returned no prices.");
              return;
            }
            let ok = 0;
            let fail = 0;
            for (const ticker of MAG7_TICKERS) {
              const p = prices.get(ticker);
              if (!p) {
                fail++;
                continue;
              }
              try {
                await pushOraclePrice(connection, wallet, {
                  ticker,
                  priceCents: Math.round(p.priceUsd * 100),
                  confCents: Math.max(1, Math.round(p.confUsd * 100)),
                  publishTime: Math.floor(Date.now() / 1000),
                });
                ok++;
              } catch (err) {
                fail++;
                reportTxError(`Push ${ticker} (Pyth)`, err);
              }
            }
            notify.success(`Pushed ${ok}/${MAG7_TICKERS.length} prices from Pyth.`);
            if (fail > 0) notify.warning(`${fail} ticker(s) failed — see errors above.`);
            await reloadOracles();
          } catch (err) {
            notify.error(`Pyth refresh failed: ${errMsg(err)}`);
          }
        }}
      />

      {/* ── MARKETS ──────────────────────────────────────────────── */}
      <GroupHeading
        title="Markets"
        purpose="Create today's strike grid, then settle each market against the oracle close after expiry."
      />
      <SettlementControl
        markets={markets}
        canSettle={connected}
        onSettle={async (m) => {
          try {
            const sig = await settleMarket(connection, wallet, m.address, m.oracle);
            notify.success(`Settled ${m.ticker} @ $${(m.strike / 100).toFixed(2)} — ${shortKey(sig)}`);
            refreshAll();
            return true;
          } catch (err) {
            reportTxError(`Settle ${m.ticker} @ $${(m.strike / 100).toFixed(2)}`, err);
            return false;
          }
        }}
      />

      <div style={{ height: 16 }} />

      {/* MARKET CREATION */}
      <MarketCreation
        markets={markets}
        oracles={oracles}
        canCreate={connected}
        onCreate={async (ticker, previousCloseCents, existingStrikes) => {
          const res = await createTodaysMarketsForTicker(
            connection,
            wallet,
            ticker,
            previousCloseCents,
            existingStrikes,
          );
          refreshAll();
          return res;
        }}
      />

      {/* ── STRIKES ──────────────────────────────────────────────── */}
      <GroupHeading
        title="Strikes"
        purpose="Add a single arbitrary strike at the next trading day's close — useful after today's market is closed."
      />
      <SyntheticStrikeControl
        oracles={oracles}
        canCreate={connected}
        onAdd={async (ticker, strikeCents, expiryTs) => {
          const res = await addSyntheticStrike(
            connection,
            wallet,
            ticker,
            strikeCents,
            expiryTs,
          );
          refreshAll();
          return res;
        }}
      />

      {/* ── DANGER ZONE ──────────────────────────────────────────── */}
      <GroupHeading
        title="Danger zone"
        purpose="Global controls that affect every market. Confirm the current state before toggling."
        tone="danger"
      />
      <PauseControl
        config={config}
        canToggle={connected}
        onToggle={async (next) => {
          try {
            const sig = await setPaused(connection, wallet, next);
            notify.success(`${next ? "Paused" : "Unpaused"} program — ${shortKey(sig)}`);
            await reloadConfig();
          } catch (err) {
            reportTxError(next ? "Pause" : "Unpause", err);
          }
        }}
      />
    </div>
  );
}

// ===========================================================================
// Group heading — scannable section divider for the operator
// ===========================================================================

function GroupHeading({
  title,
  purpose,
  tone,
}: {
  title: string;
  purpose: string;
  tone?: "danger";
}) {
  const danger = tone === "danger";
  return (
    <div style={{ marginTop: 28, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 15, color: danger ? "var(--down)" : "var(--text)" }}>
          {title}
        </h3>
        {danger && (
          <Pill tone="dn">
            <IconAlert size={11} aria-hidden /> Affects all markets
          </Pill>
        )}
      </div>
      <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--text-3)" }}>
        {purpose}
      </div>
    </div>
  );
}

// ===========================================================================
// 1. Status banner
// ===========================================================================

function StatusBanner({
  connected,
  myKey,
  config,
  configLoading,
  isAdmin,
  isOracleAuth,
  onConnect,
}: {
  connected: boolean;
  myKey: string | null;
  config: ConfigState | null;
  configLoading: boolean;
  isAdmin: boolean;
  isOracleAuth: boolean;
  onConnect: () => void;
}) {
  const notConnected = !connected;
  const wrongWallet = connected && config && !isAdmin && !isOracleAuth;

  let tone: "ok" | "warn" | "info";
  if (notConnected) tone = "info";
  else if (wrongWallet) tone = "warn";
  else tone = "ok";

  const borderColor =
    tone === "ok"
      ? "var(--up-line)"
      : tone === "warn"
        ? "var(--down-line)"
        : "var(--line)";
  const bg =
    tone === "ok"
      ? "var(--up-soft)"
      : tone === "warn"
        ? "var(--down-soft)"
        : "var(--bg-elev)";

  return (
    <Card style={{ borderColor, background: bg }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div aria-hidden style={{ marginTop: 2, color: tone === "warn" ? "var(--down)" : tone === "ok" ? "var(--up)" : "var(--text-3)" }}>
          {tone === "ok" ? <IconCheckCircle size={18} /> : tone === "warn" ? <IconAlert size={18} /> : <IconBolt size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          {notConnected ? (
            <>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
                No wallet connected
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--text-3)" }}>
                Connect a wallet to drive admin actions. Import{" "}
                <code className="kbd">keys/admin.json</code> (pubkey{" "}
                <span className="mono">{shortKey(ADMIN_PUBKEY)}</span>) to use these tools.
              </div>
              <div style={{ marginTop: 10 }}>
                <Button primary sm onClick={onConnect}>
                  Connect Wallet
                </Button>
              </div>
            </>
          ) : wrongWallet ? (
            <>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--down)" }}>
                You are not the admin wallet — admin actions will fail
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--text-3)" }}>
                Connected as <span className="mono">{shortKey(myKey)}</span>. Import{" "}
                <code className="kbd">keys/admin.json</code> (pubkey{" "}
                <span className="mono">{shortKey(ADMIN_PUBKEY)}</span>) to use these tools.
                The panel still renders — actions just revert on-chain if unauthorized.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
                {isAdmin && isOracleAuth
                  ? "Connected as admin + oracle authority"
                  : isAdmin
                    ? "Connected as admin"
                    : "Connected as oracle authority"}
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--text-3)" }}>
                <span className="mono">{shortKey(myKey)}</span> — authorized to run lifecycle actions.
              </div>
            </>
          )}

          {/* On-chain config detail */}
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px solid var(--line-soft)",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "2px 24px",
            }}
          >
            {configLoading && !config ? (
              <span style={{ fontSize: 13, color: "var(--text-3)" }}>Reading Config PDA…</span>
            ) : config ? (
              <>
                <Stat
                  k="Admin"
                  v={<KeyLink pk={config.admin} match={isAdmin} />}
                />
                <Stat
                  k="Oracle authority"
                  v={<KeyLink pk={config.oracleAuthority} match={isOracleAuth} />}
                />
                <Stat
                  k="Paused"
                  v={config.paused ? "yes" : "no"}
                  vColor={config.paused ? "var(--down)" : "var(--up)"}
                />
                <Stat k="USDC mint" v={<KeyLink pk={config.usdcMint} />} />
              </>
            ) : (
              <span style={{ fontSize: 13, color: "var(--down)" }}>
                Config PDA not found — is the program deployed at the configured ID?
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function KeyLink({ pk, match }: { pk: string; match?: boolean }) {
  return (
    <a
      href={explorerAddress(pk)}
      target="_blank"
      rel="noreferrer"
      className="mono"
      style={{
        color: match ? "var(--up)" : "var(--text-2)",
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
      title={pk}
    >
      {shortKey(pk)}
      <IconExt size={10} style={{ color: "var(--text-3)" }} />
    </a>
  );
}

// ===========================================================================
// 2. Oracle control
// ===========================================================================

function OracleControl({
  oracles,
  canPush,
  onPush,
  onRefreshAllPyth,
}: {
  oracles: OracleState[];
  canPush: boolean;
  onPush: (ticker: Ticker, priceCents: number) => Promise<void>;
  onRefreshAllPyth: () => Promise<void>;
}) {
  const [pythBusy, setPythBusy] = useState(false);

  return (
    <Card>
      <SectionTitle
        action={
          <Button
            sm
            disabled={!canPush || pythBusy}
            onClick={async () => {
              setPythBusy(true);
              try {
                await onRefreshAllPyth();
              } finally {
                setPythBusy(false);
              }
            }}
            leftIcon={<IconPyth size={13} aria-hidden />}
          >
            {pythBusy ? "Pushing…" : "Refresh all from Pyth"}
          </Button>
        }
      >
        Oracle control
      </SectionTitle>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 14 }}>
        Each row reads the on-chain oracle PDA (live Pyth Hermes prices).
        Push a price (dollars) to set the close used by settlement. Prices are
        stored in cents (expo −2). Staleness must be ≤ 300s for{" "}
        <span className="mono">settle_market</span>.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {MAG7_TICKERS.map((ticker) => {
          const o = oracles.find((x) => x.ticker === ticker);
          return (
            <OracleRow key={ticker} ticker={ticker} oracle={o} canPush={canPush} onPush={onPush} />
          );
        })}
      </div>
    </Card>
  );
}

function OracleRow({
  ticker,
  oracle,
  canPush,
  onPush,
}: {
  ticker: Ticker;
  oracle: OracleState | undefined;
  canPush: boolean;
  onPush: (ticker: Ticker, priceCents: number) => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const exists = oracle?.exists;
  const priceUsd = oracle ? oracle.priceCents / 100 : 0;
  const stale = oracle ? oracle.stalenessSec > 300 : false;

  async function submit() {
    const dollars = Number(input);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      notify.warning(`Enter a positive price for ${ticker}.`);
      return;
    }
    setBusy(true);
    try {
      await onPush(ticker, Math.round(dollars * 100));
      setInput("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        background: "var(--bg-elev-2)",
        border: "1px solid var(--line-soft)",
        borderRadius: 8,
        flexWrap: "wrap",
      }}
    >
      <div style={{ width: 120, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{ticker}</span>
        <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>{TICKER_NAME[ticker]}</span>
      </div>

      <div style={{ minWidth: 110, fontFamily: "var(--mono)" }}>
        {exists ? (
          <span style={{ fontSize: 15, color: "var(--text)" }}>${priceUsd.toFixed(2)}</span>
        ) : (
          <span style={{ fontSize: 13, color: "var(--text-4)" }}>not set</span>
        )}
      </div>

      <div style={{ minWidth: 150, display: "flex", alignItems: "center", gap: 6 }}>
        <IconClock size={12} aria-hidden style={{ color: stale ? "var(--down)" : "var(--text-3)" }} />
        {exists ? (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: stale ? "var(--down)" : "var(--up)",
            }}
          >
            {oracle!.stalenessSec}s ago{stale ? " · stale" : ""}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ position: "relative" }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-3)",
              fontSize: 13,
            }}
          >
            $
          </span>
          <input
            className="field"
            inputMode="decimal"
            aria-label={`New ${ticker} price in dollars`}
            placeholder={exists ? priceUsd.toFixed(2) : "0.00"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            style={{ width: 110, height: 32, paddingLeft: 22, fontFamily: "var(--mono)" }}
          />
        </div>
        <Button
          sm
          primary
          disabled={!canPush || busy}
          onClick={() => void submit()}
          aria-label={`Push new ${ticker} price`}
        >
          {busy ? "…" : "Push price"}
        </Button>
      </div>
    </div>
  );
}

// ===========================================================================
// 3. Settlement control
// ===========================================================================

function SettlementControl({
  markets,
  canSettle,
  onSettle,
}: {
  markets: Market[];
  canSettle: boolean;
  onSettle: (m: Market) => Promise<boolean>;
}) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const [busyAddr, setBusyAddr] = useState<string | null>(null);

  // Group markets by ticker, MAG7 order.
  const grouped = useMemo(() => {
    return MAG7_TICKERS.map((ticker) => ({
      ticker,
      rows: markets
        .filter((m) => m.ticker === ticker)
        .sort((a, b) => a.strike - b.strike),
    })).filter((g) => g.rows.length > 0);
  }, [markets]);

  const openMarkets = useMemo(() => markets.filter((m) => !m.settled), [markets]);

  async function settleAll() {
    if (openMarkets.length === 0) {
      notify.info("No open markets to settle.");
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    try {
      for (const m of openMarkets) {
        setBusyAddr(m.address);
        // Sequential — one tx each.
        // eslint-disable-next-line no-await-in-loop
        const settled = await onSettle(m);
        if (settled) ok++;
      }
    } finally {
      setBusyAddr(null);
      setBulkBusy(false);
    }
    notify.success(`Settled ${ok}/${openMarkets.length} open markets.`);
  }

  return (
    <Card>
      <SectionTitle
        action={
          <Button
            sm
            primary
            disabled={!canSettle || bulkBusy || openMarkets.length === 0}
            onClick={() => void settleAll()}
            leftIcon={<IconBolt size={13} aria-hidden />}
          >
            {bulkBusy ? "Settling…" : `Settle all open (${openMarkets.length})`}
          </Button>
        }
      >
        Settlement · End of day
      </SectionTitle>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 14 }}>
        Settlement compares the oracle close to each strike:{" "}
        <span style={{ color: "var(--text-2)" }}>closing ≥ strike → Yes wins</span>.
        Callable after expiry. If a settle reverts on staleness, push a fresh
        price for that ticker first.
      </div>

      {grouped.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-4)", padding: "20px 0", textAlign: "center" }}>
          No markets on-chain yet — create today&apos;s markets below.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {grouped.map((g) => (
            <div key={g.ticker}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>{g.ticker}</span>
                <span style={{ fontSize: 11, color: "var(--text-4)" }}>
                  {g.rows.length} strike{g.rows.length === 1 ? "" : "s"}
                </span>
              </div>
              <Card padding={0} flat style={{ overflow: "hidden" }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Strike</th>
                      <th style={{ textAlign: "right" }}>Pairs minted</th>
                      <th style={{ textAlign: "center" }}>Status</th>
                      <th style={{ textAlign: "center" }}>Outcome</th>
                      <th style={{ textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((m) => (
                      <SettleRow
                        key={m.address}
                        market={m}
                        canSettle={canSettle}
                        busy={busyAddr === m.address}
                        disabledGlobal={bulkBusy}
                        onSettle={onSettle}
                      />
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SettleRow({
  market,
  canSettle,
  busy,
  disabledGlobal,
  onSettle,
}: {
  market: Market;
  canSettle: boolean;
  busy: boolean;
  disabledGlobal: boolean;
  onSettle: (m: Market) => Promise<boolean>;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const working = busy || localBusy;

  return (
    <tr>
      <td style={{ fontFamily: "var(--mono)" }}>${(market.strike / 100).toFixed(2)}</td>
      <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-3)" }}>
        {market.totalPairsMinted.toLocaleString()}
      </td>
      <td style={{ textAlign: "center" }}>
        {market.settled ? (
          <StrikePill tone="atm">settled</StrikePill>
        ) : (
          <Pill tone="accent">
            <span className="dot" />
            open
          </Pill>
        )}
      </td>
      <td style={{ textAlign: "center" }}>
        {market.settled && market.outcome ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: market.outcome === "yes" ? "var(--up)" : "var(--down)",
            }}
          >
            {market.outcome === "yes" ? <IconCheckCircle size={13} /> : <IconXCircle size={13} />}
            {market.outcome === "yes" ? "Yes wins" : "No wins"}
            {market.settlementPrice != null && (
              <span style={{ color: "var(--text-4)" }}>
                @ ${(market.settlementPrice / 100).toFixed(2)}
              </span>
            )}
          </span>
        ) : (
          <span style={{ color: "var(--text-4)" }}>—</span>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        {market.settled ? (
          <span style={{ color: "var(--text-4)", fontSize: 12 }}>done</span>
        ) : (
          <Button
            sm
            aria-label={`Settle ${market.ticker} $${(market.strike / 100).toFixed(2)} market`}
            disabled={!canSettle || working || disabledGlobal}
            onClick={async () => {
              setLocalBusy(true);
              try {
                await onSettle(market);
              } finally {
                setLocalBusy(false);
              }
            }}
          >
            {working ? "Settling…" : "Settle"}
          </Button>
        )}
      </td>
    </tr>
  );
}

// ===========================================================================
// 4. Market creation
// ===========================================================================

function MarketCreation({
  markets,
  oracles,
  canCreate,
  onCreate,
}: {
  markets: Market[];
  oracles: OracleState[];
  canCreate: boolean;
  onCreate: (
    ticker: Ticker,
    previousCloseCents: number,
    existingStrikes: number[],
  ) => Promise<{ strikes: { strike: number; status: string; reason?: string }[] }>;
}) {
  const [busyTicker, setBusyTicker] = useState<Ticker | "all" | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const expiryTs = useMemo(() => todayExpiryTsSeconds(), []);

  /** Strikes already created today for a ticker (to skip without a tx). */
  function existingStrikesFor(ticker: Ticker): number[] {
    return markets
      .filter((m) => m.ticker === ticker && m.expiryTs === expiryTs)
      .map((m) => m.strike);
  }

  /** Source close: prefer the on-chain oracle; that's what the ±% grid keys off. */
  function closeCentsFor(ticker: Ticker): number | null {
    const o = oracles.find((x) => x.ticker === ticker);
    if (o && o.exists && o.priceCents > 0) return o.priceCents;
    return null;
  }

  function pushLog(line: string) {
    setLog((prev) => [line, ...prev].slice(0, 40));
  }

  async function createOne(ticker: Ticker): Promise<void> {
    const close = closeCentsFor(ticker);
    if (close == null) {
      pushLog(`⚠ ${ticker}: no oracle price set — push a price first (used as the strike anchor).`);
      notify.warning(`${ticker}: set the oracle price first.`);
      return;
    }
    pushLog(`→ ${ticker}: creating ±3/6/9% grid off $${(close / 100).toFixed(2)}…`);
    try {
      const res = await onCreate(ticker, close, existingStrikesFor(ticker));
      const created = res.strikes.filter((s) => s.status === "created");
      const skipped = res.strikes.filter((s) => s.status === "skipped");
      const failed = res.strikes.filter((s) => s.status === "failed");
      pushLog(
        `✓ ${ticker}: ${created.length} created, ${skipped.length} existed${
          failed.length ? `, ${failed.length} failed` : ""
        } (${res.strikes.map((s) => "$" + (s.strike / 100).toFixed(0)).join(", ")})`,
      );
      for (const f of failed) {
        pushLog(`   ✗ $${(f.strike / 100).toFixed(0)}: ${f.reason ?? "unknown"}`);
      }
      if (created.length > 0) {
        notify.success(`${ticker}: created ${created.length} market(s).`);
      } else if (failed.length === 0) {
        notify.info(`${ticker}: all strikes already exist.`);
      }
    } catch (err) {
      pushLog(`✗ ${ticker}: ${errMsg(err)}`);
      notify.error(`${ticker}: ${errMsg(err)}`);
    }
  }

  async function createAll() {
    setBusyTicker("all");
    try {
      for (const ticker of MAG7_TICKERS) {
        setBusyTicker(ticker);
        // eslint-disable-next-line no-await-in-loop
        await createOne(ticker);
      }
    } finally {
      setBusyTicker(null);
    }
  }

  return (
    <Card>
      <SectionTitle
        action={
          <Button
            sm
            primary
            disabled={!canCreate || busyTicker !== null}
            onClick={() => void createAll()}
            leftIcon={<IconBolt size={13} aria-hidden />}
          >
            {busyTicker === "all" || busyTicker !== null ? "Creating…" : "Create today's markets"}
          </Button>
        }
      >
        Market creation
      </SectionTitle>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 14 }}>
        For each ticker, computes the ±3/6/9% strike grid ($10-rounded) off the
        on-chain oracle price, then bundles{" "}
        <span className="mono">create_strike_market</span> +{" "}
        <span className="mono">init_market_books</span> for any missing strike.
        Idempotent — existing markets are skipped. Expiry ={" "}
        <span className="mono">
          {new Date(expiryTs * 1000).toLocaleString("en-US", {
            timeZone: "America/New_York",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>{" "}
        ET.
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 8,
          marginBottom: 14,
        }}
      >
        {MAG7_TICKERS.map((ticker) => {
          const close = closeCentsFor(ticker);
          const existing = existingStrikesFor(ticker).length;
          return (
            <div
              key={ticker}
              style={{
                padding: "10px 12px",
                background: "var(--bg-elev-2)",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{ticker}</span>
                <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
                  {existing} live
                </span>
              </div>
              <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: close ? "var(--text-2)" : "var(--text-4)" }}>
                {close ? `$${(close / 100).toFixed(2)} close` : "no oracle"}
              </div>
              <Button
                sm
                ghost
                aria-label={`Create today's ${ticker} strike grid`}
                disabled={!canCreate || busyTicker !== null || close == null}
                onClick={() => {
                  setBusyTicker(ticker);
                  void createOne(ticker).finally(() => setBusyTicker(null));
                }}
              >
                {busyTicker === ticker ? "…" : "Create"}
              </Button>
            </div>
          );
        })}
      </div>

      {log.length > 0 && (
        <div
          style={{
            marginTop: 6,
            padding: "10px 12px",
            background: "var(--bg)",
            border: "1px solid var(--line-soft)",
            borderRadius: 8,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--text-2)",
            maxHeight: 200,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {log.map((line, i) => (
            <div key={i} style={{ whiteSpace: "pre-wrap" }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ===========================================================================
// 4b. Synthetic strike — single arbitrary strike at a future expiry
// ===========================================================================

function SyntheticStrikeControl({
  oracles,
  canCreate,
  onAdd,
}: {
  oracles: OracleState[];
  canCreate: boolean;
  onAdd: (
    ticker: Ticker,
    strikeCents: number,
    expiryTs: number,
  ) => Promise<{ strike: number; expiryTs: number; market: string; created: boolean }>;
}) {
  const [ticker, setTicker] = useState<Ticker>(MAG7_TICKERS[0]!);
  const [strikeStr, setStrikeStr] = useState("");
  const [busy, setBusy] = useState(false);
  // Default expiry = next NYSE trading day's 4 PM ET close, so the new market is
  // non-settled + tradeable past today's 0DTE close. Computed once per mount,
  // mirroring MarketCreation's todayExpiryTsSeconds() useMemo.
  const expiryTs = useMemo(() => nextTradingDayExpiryTs(), []);
  const oraclePrice = oracles.find((o) => o.ticker === ticker && o.exists)?.priceCents ?? null;

  async function submit() {
    const dollars = Number(strikeStr);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      notify.warning("Enter a positive strike price in dollars.");
      return;
    }
    setBusy(true);
    try {
      const res = await onAdd(ticker, Math.round(dollars * 100), expiryTs);
      if (res.created) {
        notify.success(
          `Added ${ticker} $${(res.strike / 100).toFixed(2)} strike — ${shortKey(res.market)}`,
        );
        setStrikeStr("");
      } else {
        notify.info(`${ticker} $${(res.strike / 100).toFixed(2)} @ that expiry already exists.`);
      }
    } catch (err) {
      reportTxError(`Add ${ticker} strike`, err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>Add synthetic strike</SectionTitle>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 14 }}>
        Admin-only. Adds ONE arbitrary strike via{" "}
        <span className="mono">add_strike</span> +{" "}
        <span className="mono">init_market_books</span> at the next trading day&apos;s
        4:00 PM ET expiry, so it&apos;s a fresh tradeable market{" "}
        <span style={{ color: "var(--text-2)" }}>even after today&apos;s close</span>. Expiry ={" "}
        <span className="mono">
          {new Date(expiryTs * 1000).toLocaleString("en-US", {
            timeZone: "America/New_York",
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>{" "}
        ET.
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Label>
            <label htmlFor="synth-ticker">Ticker</label>
          </Label>
          <select
            id="synth-ticker"
            className="field"
            value={ticker}
            onChange={(e) => setTicker(e.target.value as Ticker)}
            style={{ height: 36, minWidth: 110 }}
          >
            {MAG7_TICKERS.map((t) => (
              <option key={t} value={t}>
                {t} — {TICKER_NAME[t]}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Label>
            <label htmlFor="synth-strike">Strike (USD)</label>
          </Label>
          <div style={{ position: "relative" }}>
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-3)",
                fontSize: 13,
              }}
            >
              $
            </span>
            <input
              id="synth-strike"
              className="field"
              inputMode="decimal"
              placeholder={oraclePrice != null ? (oraclePrice / 100).toFixed(2) : "0.00"}
              value={strikeStr}
              onChange={(e) => setStrikeStr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              style={{ width: 130, height: 36, paddingLeft: 22, fontFamily: "var(--mono)" }}
            />
          </div>
        </div>

        <Button
          primary
          disabled={!canCreate || busy}
          onClick={() => void submit()}
          leftIcon={<IconBolt size={13} aria-hidden />}
        >
          {busy ? "Adding…" : "Add strike"}
        </Button>
      </div>
    </Card>
  );
}

// ===========================================================================
// 5. Pause / unpause
// ===========================================================================

function PauseControl({
  config,
  canToggle,
  onToggle,
}: {
  config: ConfigState | null;
  canToggle: boolean;
  onToggle: (next: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const paused = config?.paused ?? false;

  // Pausing halts trading for every market — require an explicit confirm click.
  // Unpausing is restorative, so it runs immediately.
  const willPause = !paused;

  async function run() {
    setBusy(true);
    try {
      await onToggle(!paused);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <Card>
      <SectionTitle>Pause / Unpause trading</SectionTitle>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12.5, color: "var(--text-3)", maxWidth: 540 }}>
          The global pause flag halts <span className="mono">place_order</span>,{" "}
          <span className="mono">mint_pair</span> and{" "}
          <span className="mono">redeem_pair</span> for all markets.{" "}
          Current state:{" "}
          <span style={{ color: paused ? "var(--down)" : "var(--up)", fontWeight: 600 }}>
            {paused ? "Paused" : "Active"}
          </span>
          .
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {armed && willPause && !busy && (
            <span style={{ fontSize: 12.5, color: "var(--down)" }}>
              Pause all markets?
            </span>
          )}
          {armed && willPause && !busy && (
            <Button sm ghost onClick={() => setArmed(false)} aria-label="Cancel pause">
              Cancel
            </Button>
          )}
          <Button
            lg
            // Pause is destructive → down tokens; unpause is restorative → primary accent.
            primary={!willPause}
            disabled={!canToggle || busy || !config}
            onClick={() => {
              if (willPause && !armed) {
                setArmed(true);
                return;
              }
              void run();
            }}
            style={
              willPause
                ? {
                    background: armed ? "var(--down)" : "transparent",
                    color: armed ? "var(--down-ink)" : "var(--down)",
                    borderColor: "var(--down-line)",
                  }
                : undefined
            }
          >
            {busy
              ? "Submitting…"
              : willPause
                ? armed
                  ? "Confirm pause"
                  : "Pause program"
                : "Unpause program"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
