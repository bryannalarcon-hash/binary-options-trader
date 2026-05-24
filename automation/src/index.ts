import * as cron from "node-cron";

import { env } from "./env";
import { markEnd, markStart, startHealthServer } from "./health";
import { runMorningJob } from "./jobs/morning";
import { runSettleJob } from "./jobs/settle";
import { runOracleUpdaterOnce } from "./jobs/update-mock-oracle";
import { ctx, logger } from "./logger";

/**
 * Automation service entrypoint.
 *
 * Registers cron jobs for:
 *  - Morning market creation (AUTOMATION_MORNING_CRON, default 8 AM ET weekdays)
 *  - Settlement (AUTOMATION_SETTLE_CRON, default 4:05 PM ET weekdays)
 *  - Mock-oracle updates (every ORACLE_UPDATE_INTERVAL_SECONDS while USE_MOCK_ORACLE=true)
 *
 * Also serves a JSON /health endpoint on AUTOMATION_HEALTH_PORT (default 3001).
 */
async function main(): Promise<void> {
  const log = ctx("index");
  log.info(
    {
      cluster: env.cluster,
      rpcUrl: env.rpcUrl,
      useMockOracle: env.useMockOracle,
      skipCalendarCheck: env.skipCalendarCheck,
      morningCron: env.morningCron,
      settleCron: env.settleCron,
      healthPort: env.healthPort,
    },
    "Meridian automation service starting",
  );

  startHealthServer(env.healthPort);

  // -------- Morning job --------
  cron.schedule(env.morningCron, () => {
    void runJob("morning", runMorningJob);
  });
  log.info({ cron: env.morningCron }, "morning job scheduled");

  // -------- Settle job --------
  cron.schedule(env.settleCron, () => {
    void runJob("settle", runSettleJob);
  });
  log.info({ cron: env.settleCron }, "settle job scheduled");

  // -------- Mock-oracle updater (localnet only) --------
  if (env.useMockOracle) {
    const seconds = Math.max(5, env.oracleUpdateIntervalSeconds);
    const spec = `*/${seconds} * * * * *`;
    cron.schedule(spec, () => {
      void runJob("oracle", runOracleUpdaterOnce);
    });
    log.info({ interval: seconds }, "mock-oracle updater scheduled");
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

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "automation service crashed");
  process.exit(1);
});
