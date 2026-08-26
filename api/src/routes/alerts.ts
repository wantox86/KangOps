import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getWebhookConfig, maskWebhookUrl, saveWebhookConfig } from "../alerts/webhookConfigRepo.js";
import { webhookConfigSchema } from "../alerts/types.js";
import type { DbClient } from "../db/client.js";
import { alerts } from "../db/schema.js";

const webhookConfigResponseSchema = {
  type: "object",
  required: ["enabled", "urlMasked", "format", "cooldownMinutes"],
  properties: {
    enabled: { type: "boolean" },
    urlMasked: { type: ["string", "null"] },
    format: { type: "string" },
    cooldownMinutes: { type: "integer" },
  },
} as const;

const alertSchema = {
  type: "object",
  required: ["id", "entityType", "entityId", "code", "severity", "destination", "status", "summary", "sentAt", "error"],
  properties: {
    id: { type: "integer" },
    entityType: { type: "string" },
    entityId: { type: "string" },
    code: { type: "string" },
    severity: { type: "string" },
    destination: { type: "string" },
    status: { type: "string" },
    summary: { type: "string" },
    sentAt: { type: "string" },
    error: { type: ["string", "null"] },
  },
} as const;

const alertsListResponseSchema = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: alertSchema } },
} as const;

// GET/PUT /api/v1/settings/webhook: its own small endpoint (not folded into GET/PUT
// /api/v1/settings, which is thresholds-shaped) per CLAUDE.md's "each capability has a small
// boundary" -- also lets GET mask the URL without complicating the thresholds response shape.
// GET /api/v1/alerts: recent webhook delivery history, mainly for diagnosing "did my alert
// actually fire" without grepping container logs (per CLAUDE.md's "maintain lightweight
// internal metrics... display diagnostics").
export function registerAlertRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/settings/webhook", { schema: { response: { 200: webhookConfigResponseSchema } } }, async () => {
    const config = getWebhookConfig(db);
    return { enabled: config.enabled, urlMasked: maskWebhookUrl(config.url), format: config.format, cooldownMinutes: config.cooldownMinutes };
  });

  app.put("/api/v1/settings/webhook", { schema: { response: { 200: webhookConfigResponseSchema } } }, async (request, reply) => {
    const parsed = webhookConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_webhook_config", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    saveWebhookConfig(db, parsed.data, new Date().toISOString());
    return { enabled: parsed.data.enabled, urlMasked: maskWebhookUrl(parsed.data.url), format: parsed.data.format, cooldownMinutes: parsed.data.cooldownMinutes };
  });

  app.get("/api/v1/alerts", { schema: { response: { 200: alertsListResponseSchema } } }, async () => {
    const rows = db.select().from(alerts).orderBy(desc(alerts.sentAt)).limit(50).all();
    return { items: rows };
  });
}
