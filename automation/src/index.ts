import * as cron from "node-cron";

import { env } from "./env";
import { markEnd, markStart, startHealthServer } from "./health";
import { runMorningJob } from "./jobs/morning";
import { runSettleJob } from "./jobs/settle";
import { runOracleUpdaterOnce } from "./jobs/update-oracle";
import { ctx, logger } from "./logger";

/**
 * Automation service entrypoint.
 *
 * Registers cron jobs for:
 *  - Morning market creation (AUTOMATION_MORNING_CRON, default 8 AM ET weekdays)
 *  - Settlement (AUTOMATION_SETTLE_CRON, default 4:05 PM ET weekdays)
 *  - Oracle updates from Pyth Hermes (every ORACLE_UPDATE_INTERVAL_SECONDS while USE_HERMES_ORACLE=true)
 *
 * Also serves a JSON /health endpoint on AUTOMATION_HEALTH_PORT (default 3001).
 */
/**
 * Keep the service alive through transient RPC failures. The dominant crash
 * mode is a 429 ("rate limited") surfacing from web3.js's WebSocket
 * confirmation path as an *unhandled rejection* — which Node ≥15 turns into a
 * process exit, so Railway restart-loops. These are transient and the next
 * cron pass recovers on its own, so we log and keep running rather than die.
 * (Each cron job already try/catches its own awaited errors via `runJob`; this
 * only catches the ones that escape an awaited scope.)
 */
export function installGlobalErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error({ err: msg }, "unhandledRejection — staying alive (likely transient RPC/WS error)");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err: err.message }, "uncaughtException — staying alive (likely transient RPC/WS error)");
  });
}

async function main(): Promise<void> {
  const log = ctx("index");
  installGlobalErrorHandlers();
  log.info(
    {
      cluster: env.cluster,
      rpcUrl: env.rpcUrl,
      useHermesOracle: env.useHermesOracle,
      skipCalendarCheck: env.skipCalendarCheck,
      morningCron: env.morningCron,
      settleCron: env.settleCron,
      healthPort: env.healthPort,
    },
    "Meridian automation service starting",
  );

  startHealthServer(env.healthPort);

  // -------- Morning job --------
  // `timezone` makes the expression wall-clock ET (handles DST + non-UTC hosts).
  cron.schedule(
    env.morningCron,
    () => {
      void runJob("morning", runMorningJob);
    },
    { timezone: env.cronTimezone },
  );
  log.info({ cron: env.morningCron, tz: env.cronTimezone }, "morning job scheduled");

  // -------- Settle job --------
  cron.schedule(
    env.settleCron,
    () => {
      void runJob("settle", runSettleJob);
    },
    { timezone: env.cronTimezone },
  );
  log.info({ cron: env.settleCron, tz: env.cronTimezone }, "settle job scheduled");

  // -------- Hermes oracle updater (pulls live Pyth prices on-chain) --------
  if (env.useHermesOracle) {
    const seconds = Math.max(5, env.oracleUpdateIntervalSeconds);
    const spec = `*/${seconds} * * * * *`;
    cron.schedule(spec, () => {
      void runJob("oracle", runOracleUpdaterOnce);
    });
    log.info({ interval: seconds }, "hermes oracle updater scheduled");
  }

  log.info("automation service ready");

  // Graceful shutdown.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function shutdown(signal: string): void {
  logger.info({ signal }, "shutdown requested — exiting");
  process.exit(0);
}

async function runJob<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<void> {
  const log = ctx(name);
  markStart(name);
  try {
    await fn();
    markEnd(name, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, `${name} job failed`);
    markEnd(name, false, msg);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "automation service crashed");
    process.exit(1);
  });
}
