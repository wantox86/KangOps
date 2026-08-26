import { inArray, lt } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { metricSamples, metricSamplesHourly } from "../db/schema.js";
import { DEFAULT_RETENTION_CONFIG, downsampleToHourly, type RetentionConfig } from "./retention.js";

// I/O wrapper around the pure downsampleToHourly: reads all raw samples, folds anything older
// than the raw retention window into metric_samples_hourly, deletes the folded raw rows, and
// separately prunes hourly rollups past their own (much longer) retention window. Cheap enough
// to run on every collector cycle at homelab scale (dozens of containers, one host) -- no
// separate scheduler/cron needed per CLAUDE.md's "avoid overengineering".
export function runRetention(db: DbClient, nowIso: string, config: RetentionConfig = DEFAULT_RETENTION_CONFIG): void {
  const now = new Date(nowIso).getTime();
  const rawCutoffIso = new Date(now - config.rawRetentionMs).toISOString();
  const hourlyCutoffIso = new Date(now - config.hourlyRetentionMs).toISOString();

  const rawSamples = db.select().from(metricSamples).all();
  const { hourly, foldedSampleIds } = downsampleToHourly(rawSamples, rawCutoffIso);

  if (hourly.length > 0) {
    db.insert(metricSamplesHourly).values(hourly).run();
  }
  if (foldedSampleIds.length > 0) {
    db.delete(metricSamples).where(inArray(metricSamples.id, foldedSampleIds)).run();
  }

  db.delete(metricSamplesHourly).where(lt(metricSamplesHourly.bucketStart, hourlyCutoffIso)).run();
}
