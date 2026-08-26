import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "../db/client.js";
import { settings } from "../db/schema.js";
import { DEFAULT_THRESHOLDS, type HealthThresholds } from "./types.js";

const SETTINGS_KEY = "health_thresholds";

// Same shape as HealthThresholds -- validated at the boundary (per CLAUDE.md: "Validate all
// external data ... database JSON") since settings.value is untyped text in SQLite.
export const thresholdsSchema = z
  .object({
    cpuWarningPercent: z.number().min(0).max(100),
    cpuCriticalPercent: z.number().min(0).max(100),
    memoryWarningPercent: z.number().min(0).max(100),
    memoryCriticalPercent: z.number().min(0).max(100),
    diskWarningPercent: z.number().min(0).max(100),
    diskCriticalPercent: z.number().min(0).max(100),
    restartLoopCount: z.number().int().min(1),
    restartLoopWindowMinutes: z.number().int().min(1),
    healthyMinScore: z.number().min(0).max(100),
    attentionMinScore: z.number().min(0).max(100),
  })
  .refine((v) => v.healthyMinScore > v.attentionMinScore, {
    message: "healthyMinScore must be greater than attentionMinScore",
  });

export function getThresholds(db: DbClient): HealthThresholds {
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).all()[0];
  if (!row) return DEFAULT_THRESHOLDS;

  try {
    const parsed = thresholdsSchema.parse(JSON.parse(row.value));
    return parsed;
  } catch {
    // Corrupt/stale settings row shouldn't take the whole health engine down -- fall back to
    // defaults and let a future PUT /api/v1/settings overwrite it with something valid.
    return DEFAULT_THRESHOLDS;
  }
}

export function saveThresholds(db: DbClient, thresholds: HealthThresholds, nowIso: string): void {
  const value = JSON.stringify(thresholds);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: nowIso })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } })
    .run();
}
