import { env } from "../env";
import { ctx } from "../logger";

const log = ctx("alerts");

export interface AlertPayload {
  severity: "warning" | "error" | "info";
  source: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Post a structured alert to ALERT_WEBHOOK_URL.
 *
 * Best-effort: a failed webhook is logged but does NOT throw — alerts must
 * never crash a job.
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  if (!env.alertWebhookUrl) {
    log.debug({ payload }, "alert (no webhook configured, logging only)");
    return;
  }

  try {
    const res = await fetch(env.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        ...payload,
      }),
      // Cap the request — webhooks should be fast.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, payload },
        "alert webhook returned non-2xx",
      );
    }
  } catch (err) {
    log.warn({ err, payload }, "alert webhook failed");
  }
}
