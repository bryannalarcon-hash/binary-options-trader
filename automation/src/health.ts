import * as http from "http";

import { handleFaucet } from "./faucet";
import { ctx } from "./logger";

const log = ctx("health");

export interface JobRunRecord {
  lastStart?: string;
  lastEnd?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  nextRun?: string;
}

const state = {
  startedAt: new Date().toISOString(),
  jobs: {} as Record<string, JobRunRecord>,
};

/** Mark a job as started. */
export function markStart(job: string): void {
  const rec = (state.jobs[job] ??= {});
  rec.lastStart = new Date().toISOString();
}

/** Mark a job as completed with status. */
export function markEnd(job: string, ok: boolean, error?: string): void {
  const rec = (state.jobs[job] ??= {});
  rec.lastEnd = new Date().toISOString();
  rec.lastStatus = ok ? "ok" : "error";
  if (!ok && error) rec.lastError = error;
}

/** Record the upcoming-run timestamp for a job (best-effort, computed by caller). */
export function setNextRun(job: string, nextIso: string | undefined): void {
  const rec = (state.jobs[job] ??= {});
  rec.nextRun = nextIso;
}

/**
 * Start the health-check HTTP server.
 * Returns the underlying http.Server so the caller can close() it during tests.
 */
export function startHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/faucet") {
      void handleFaucet(req, res);
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          startedAt: state.startedAt,
          uptimeSeconds: Math.floor(
            (Date.now() - new Date(state.startedAt).getTime()) / 1000,
          ),
          jobs: state.jobs,
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, () => {
    log.info({ port }, "health server listening on /health");
  });

  server.on("error", (err) => {
    log.error({ err: String(err) }, "health server error");
  });

  return server;
}
