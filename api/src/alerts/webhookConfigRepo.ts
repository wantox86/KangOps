import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { settings } from "../db/schema.js";
import { DEFAULT_WEBHOOK_CONFIG, webhookConfigSchema, type WebhookConfig } from "./types.js";

const SETTINGS_KEY = "alert_webhook_config";

// Same read/fallback-on-corrupt pattern as health/thresholdsRepo.ts.
export function getWebhookConfig(db: DbClient): WebhookConfig {
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).all()[0];
  if (!row) return DEFAULT_WEBHOOK_CONFIG;
  try {
    return webhookConfigSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_WEBHOOK_CONFIG;
  }
}

export function saveWebhookConfig(db: DbClient, config: WebhookConfig, nowIso: string): void {
  const value = JSON.stringify(config);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: nowIso })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } })
    .run();
}

// Never return the raw URL from a GET -- per CLAUDE.md's security checklist ("no secrets appear
// in API responses") and the settings data-model note ("secrets never returned"). Shows just
// enough (scheme + host) to confirm "yes, something is configured" without leaking the
// unguessable path/token most webhook URLs (ntfy topics, Discord webhook IDs) encode.
export function maskWebhookUrl(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "***";
  }
}
