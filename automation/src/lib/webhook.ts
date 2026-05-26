/**
 * Generic webhook helper for operational alerts.
 *
 * This is intentionally simpler than `lib/alerts.ts` so it can be called from
 * any module without coupling to the alert taxonomy. `lib/alerts.ts` wraps this
 * with severity/source defaults; callers needing structured alerts should keep
 * using `sendAlert` from `alerts.ts`. Direct callers that want raw delivery
 * (e.g. a position-monitoring webhook firing on every fill) can use
 * `postWebhook` directly.
 *
 * Behavior:
 *   - If `url` is empty/undefined: silently noop (returns false).
 *   - On non-2xx response or network error: logs a warning, swallows the
 *     exception (alerts must NEVER crash a job), returns false.
 *   - On success: returns true.
 *
 * Payload shape (from spec):
 *   { severity, source, message, ticker?, market?, timestamp }
 *
 * The helper auto-stamps `timestamp` if the caller doesn't provide one.
 */

import { ctx } from "../logger";

const log = ctx("webhook");

export type AlertSeverity = "info" | "warning" | "error" | "critical";

export interface WebhookPayload {
  severity: AlertSeverity;
  source: string;
  message: string;
  ticker?: string;
  market?: string;
  timestamp?: string;
  /**
   * Free-form details. Kept loose because different events (settlement,
   * fill, oracle failure) carry wildly different metadata.
   */
  details?: Record<string, unknown>;
}

/**
 * POST a JSON payload to `url`. Returns true on 2xx, false otherwise.
 *
 * The function is best-effort: it never throws, so callers don't need to wrap
 * it in try/catch. A 5-second timeout caps the worst-case latency impact on
 * cron jobs.
 */
export async function postWebhook(
  url: string | undefined,
  payload: WebhookPayload,
): Promise<boolean> {
  if (!url || url.trim() === "") {
    log.debug({ payload }, "webhook noop (no url configured)");
    return false;
  }

  const body = {
    ...payload,
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, severity: payload.severity, source: payload.source },
        "webhook returned non-2xx",
      );
      return false;
    }
    log.debug(
      { severity: payload.severity, source: payload.source },
      "webhook delivered",
    );
    return true;
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        severity: payload.severity,
        source: payload.source,
      },
      "webhook delivery failed",
    );
    return false;
  }
}
