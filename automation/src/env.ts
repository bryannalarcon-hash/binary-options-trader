// env.ts — typed environment configuration for the automation service.
// Loads .env.local then .env, normalizes via req/num/bool/boolAny/pairs
// helpers, and exports the single `env` object every module reads from.

import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.local first (localnet overrides), then .env as fallback.
// dotenv.config does NOT overwrite vars that are already set, so .env.local
// wins when present, and Railway's container-injected env vars trump both.
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// On Railway: PORT is injected by the platform — map it to AUTOMATION_HEALTH_PORT
// so our health server binds to the right port without code changes.
if (process.env.PORT && !process.env.AUTOMATION_HEALTH_PORT) {
  process.env.AUTOMATION_HEALTH_PORT = process.env.PORT;
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`[env] Missing required env var: ${name}`);
  return v;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * Read a boolean from the first env var that is set, scanning `names` in order.
 * Used for backward-compatible renames (e.g. USE_HERMES_ORACLE ?? USE_MOCK_ORACLE).
 */
function boolAny(names: string[], fallback = false): boolean {
  for (const name of names) {
    if (process.env[name] !== undefined) return bool(name, fallback);
  }
  return fallback;
}

/**
 * Parse a comma-separated "KEY:VALUE" list (e.g. "AAPL-T:AAPL,MSFT-T:MSFT")
 * into a Record. Blank or malformed entries are skipped. Empty default.
 */
function pairs(name: string): Record<string, string> {
  const v = process.env[name];
  if (!v) return {};
  const out: Record<string, string> = {};
  for (const entry of v.split(",")) {
    const [key, value] = entry.split(":").map((s) => s.trim());
    if (key && value) out[key] = value;
  }
  return out;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(`[env] ${name} is not a valid number: ${v}`);
  }
  return n;
}

export const env = {
  // -------- Network --------
  rpcUrl: req("SOLANA_RPC_URL", "http://localhost:8899"),
  wsUrl: process.env.SOLANA_WS_URL || "ws://localhost:8900",
  cluster: req("SOLANA_CLUSTER", "localnet"),

  // -------- Program / mints --------
  programId: process.env.MERIDIAN_PROGRAM_ID || "",
  usdcMint: process.env.USDC_MINT || "",

  // -------- Keypairs --------
  adminKeypairPath: req(
    "ADMIN_KEYPAIR_PATH",
    "/home/bryann/gauntlet/meridian/keys/admin.json",
  ),
  automationKeypairPath: req(
    "AUTOMATION_KEYPAIR_PATH",
    "/home/bryann/gauntlet/meridian/keys/automation.json",
  ),

  // -------- Cron schedules --------
  // Expressions are interpreted in `cronTimezone` (default America/New_York),
  // so they read as wall-clock ET regardless of the host TZ or DST. Morning
  // job at 8:00 AM ET (before 9:30 open), settle at 4:05 PM ET (just after
  // close), reclaim at 4:30 PM ET (after settle, so books are closeable).
  morningCron: process.env.AUTOMATION_MORNING_CRON || "0 8 * * 1-5",
  settleCron: process.env.AUTOMATION_SETTLE_CRON || "5 16 * * 1-5",
  reclaimCron: process.env.AUTOMATION_RECLAIM_CRON || "30 16 * * 1-5",
  // IANA timezone the morning/settle crons are evaluated in. Pinning this to
  // America/New_York means we never have to hand-convert to UTC or chase DST.
  cronTimezone: process.env.AUTOMATION_CRON_TIMEZONE || "America/New_York",

  // -------- Settle retry tuning --------
  settleRetryInterval: num("AUTOMATION_SETTLE_RETRY_INTERVAL", 30),
  settleMaxRetrySeconds: num("AUTOMATION_SETTLE_MAX_RETRY_SECONDS", 900),

  // -------- Oracle --------
  oracleMaxStalenessSeconds: num("ORACLE_MAX_STALENESS_SECONDS", 30),
  oracleMaxConfidenceRatio: num("ORACLE_MAX_CONFIDENCE_RATIO", 0.005),
  pythHermesUrl: process.env.PYTH_HERMES_URL || "https://hermes.pyth.network",
  oracleUpdateIntervalSeconds: num("ORACLE_UPDATE_INTERVAL_SECONDS", 60),
  pythFeeds: {
    AAPL: process.env.PYTH_FEED_AAPL || "",
    MSFT: process.env.PYTH_FEED_MSFT || "",
    GOOGL: process.env.PYTH_FEED_GOOGL || "",
    AMZN: process.env.PYTH_FEED_AMZN || "",
    NVDA: process.env.PYTH_FEED_NVDA || "",
    META: process.env.PYTH_FEED_META || "",
    TSLA: process.env.PYTH_FEED_TSLA || "",
  } as Record<string, string>,
  // Mirror a real ticker's Hermes price onto a TEST ticker's oracle PDA each
  // oracle pass. Format: "AAPL-T:AAPL,MSFT-T:MSFT" (test:source pairs).
  testTickerMirrors: pairs("TEST_TICKER_MIRRORS"),

  // -------- Dev toggles --------
  // Pull live prices from Pyth Hermes and write them on-chain via update_oracle.
  // Backward-compat: honour the legacy USE_MOCK_ORACLE name if the new one is unset.
  useHermesOracle: boolAny(["USE_HERMES_ORACLE", "USE_MOCK_ORACLE"], false),
  skipCalendarCheck: bool("SKIP_CALENDAR_CHECK", false),
  testBypassTimeGate: bool("TEST_BYPASS_TIME_GATE", false),

  // -------- Ops --------
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || "",
  healthPort: num("AUTOMATION_HEALTH_PORT", 3001),
  logLevel: process.env.LOG_LEVEL || "info",
};
