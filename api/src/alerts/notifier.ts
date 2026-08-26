import { desc, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { DbClient } from "../db/client.js";
import { alerts } from "../db/schema.js";
import { shouldSendAlert } from "./cooldown.js";
import { sendWebhook } from "./dispatch.js";
import { buildWebhookRequest, type AlertableCondition } from "./format.js";
import { getWebhookConfig } from "./webhookConfigRepo.js";

function dedupeKey(entityType: string, entityId: string, code: string): string {
  return `${entityType}:${entityId}:${code}`;
}

// Fires webhook alerts for newly-opened health conditions -- called from health/cycle.ts right
// after reconcile.ts decides what's new this cycle, so "deduplication" is already mostly free
// (an already-active condition never reappears in `newlyOpened`); cooldownMinutes additionally
// guards against a flapping condition (resolve/reopen/resolve/reopen) re-alerting every cycle.
// Per CLAUDE.md's "graceful degradation": a webhook failure is recorded and logged, never
// thrown -- it must not take down the collector/health cycle that called it.
export async function dispatchAlerts(db: DbClient, newlyOpened: AlertableCondition[], hostId: string, nowIso: string, logger?: FastifyBaseLogger): Promise<void> {
  if (newlyOpened.length === 0) return;

  const config = getWebhookConfig(db);
  if (!config.enabled || !config.url) return;

  for (const condition of newlyOpened) {
    const key = dedupeKey(condition.entityType, condition.entityId, condition.code);
    const lastAlert = db.select().from(alerts).where(eq(alerts.dedupeKey, key)).orderBy(desc(alerts.sentAt)).limit(1).all()[0];

    if (!shouldSendAlert(lastAlert?.sentAt ?? null, nowIso, config.cooldownMinutes)) continue;

    const request = buildWebhookRequest(config.format, condition, hostId);
    let result: { ok: boolean; error: string | null };
    try {
      result = await sendWebhook(config.url, request);
    } catch (err) {
      // sendWebhook already catches network errors internally; this is a last-resort guard so a
      // truly unexpected throw still can't escape and fail the calling health cycle.
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    db.insert(alerts)
      .values({
        entityType: condition.entityType,
        entityId: condition.entityId,
        code: condition.code,
        severity: condition.severity,
        destination: "webhook",
        status: result.ok ? "sent" : "failed",
        summary: condition.summary,
        dedupeKey: key,
        sentAt: nowIso,
        error: result.error,
      })
      .run();

    if (!result.ok) {
      logger?.warn({ code: condition.code, entityType: condition.entityType, entityId: condition.entityId }, "webhook alert delivery failed");
    }
  }
}
