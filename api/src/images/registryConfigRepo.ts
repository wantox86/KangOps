import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "../db/client.js";
import { settings } from "../db/schema.js";

const SETTINGS_KEY = "registry_check_config";

export interface RegistryCheckConfig {
  enabled: boolean;
}

export const DEFAULT_REGISTRY_CONFIG: RegistryCheckConfig = { enabled: false };

export const registryConfigSchema = z.object({ enabled: z.boolean() });

// Explicit opt-in flag, off by default -- per CLAUDE.md's Milestone 4 scope ("behind explicit
// registry configuration (opt-in, jangan auto-connect ke registry tanpa config eksplisit dari
// user)"). Same settings-table pattern as thresholdsRepo/webhookConfigRepo.
export function getRegistryConfig(db: DbClient): RegistryCheckConfig {
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).all()[0];
  if (!row) return DEFAULT_REGISTRY_CONFIG;
  try {
    return registryConfigSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_REGISTRY_CONFIG;
  }
}

export function saveRegistryConfig(db: DbClient, config: RegistryCheckConfig, nowIso: string): void {
  const value = JSON.stringify(config);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: nowIso })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } })
    .run();
}
