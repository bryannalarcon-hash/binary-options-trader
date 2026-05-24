import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.local first (localnet overrides), then .env as fallback.
// dotenv.config does NOT overwrite vars that are already set, so .env.local wins.
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

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
  morningCron: process.env.AUTOMATION_MORNING_CRON || "0 12 * * 1-5",
  settleCron: process.env.AUTOMATION_SETTLE_CRON || "5 20 * * 1-5",

  // -------- Settle retry tuning --------
  settleRetryInterval: num("AUTOMATION_SETTLE_RETRY_INTERVAL", 30),
  settleMaxRetrySeconds: num("AUTOMATION_SETTLE_MAX_RETRY_SECONDS", 900),

  // -------- Oracle --------
  oracleMaxStalenessSeconds: num("ORACLE_MAX_STALENESS_SECONDS", 30),
  oracleMaxConfidenceRatio: num("ORACLE_MAX_CONFIDENCE_RATIO", 0.005),
  pythHermesUrl: process.env.PYTH_HERMES_URL || "https://hermes.pyth.network",
  oracleUpdateIntervalSeconds: num("ORACLE_UPDATE_INTERVAL_SECONDS", 30),
  pythFeeds: {
    AAPL: process.env.PYTH_FEED_AAPL || "",
    MSFT: process.env.PYTH_FEED_MSFT || "",
    GOOGL: process.env.PYTH_FEED_GOOGL || "",
    AMZN: process.env.PYTH_FEED_AMZN || "",
    NVDA: process.env.PYTH_FEED_NVDA || "",
    META: process.env.PYTH_FEED_META || "",
    TSLA: process.env.PYTH_FEED_TSLA || "",
  } as Record<string, string>,

  // -------- Dev toggles --------
  useMockOracle: bool("USE_MOCK_ORACLE", false),
  skipCalendarCheck: bool("SKIP_CALENDAR_CHECK", false),
  testBypassTimeGate: bool("TEST_BYPASS_TIME_GATE", false),

  // -------- Ops --------
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || "",
  healthPort: num("AUTOMATION_HEALTH_PORT", 3001),
  logLevel: process.env.LOG_LEVEL || "info",
};
