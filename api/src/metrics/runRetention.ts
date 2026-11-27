import { inArray, lt } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { metricSamples, metricSamplesHourly } from "../db/schema.js";
import { DEFAULT_RETENTION_CONFIG, downsampleToHourly, type RetentionConfig } from "./retention.js";

const DELETE_BATCH_SIZE = 500;

// I/O wrapper around the pure downsampleToHourly: queries only raw samples strictly older than
// rawCutoffIso (backed by metric_samples_observed_at_idx so we don't scan/allocate the entire
// 24h raw table every 20s), folds any fully-closed hours into metric_samples_hourly, deletes the
// folded raw rows, and separately prunes hourly rollups past their own retention window.
// Filtering observedAt < rawCutoffIso is mathematically equivalent to scanning all rows for
// downsampleToHourly because a closed hour satisfies bucketStart + 1h <= cutoff, which implies
// every sample in that hour has observedAt < bucketStart + 1h <= cutoff.
export function runRetention(db: DbClient, nowIso: string, config: RetentionConfig = DEFAULT_RETENTION_CONFIG): void {
  const now = new Date(nowIso).getTime();
  const rawCutoffIso = new Date(now - config.rawRetentionMs).toISOString();
  const hourlyCutoffIso = new Date(now - config.hourlyRetentionMs).toISOString();

  const rawSamples = db.select().from(metricSamples).where(lt(metricSamples.observedAt, rawCutoffIso)).all();
  const { hourly, foldedSampleIds } = downsampleToHourly(rawSamples, rawCutoffIso);

  // Fold + delete atomically: if the process died between the insert and the delete, the raw rows
  // would survive and the same (closed) bucket would be folded again on the next cycle, producing
  // a duplicate hourly row. Wrapping both in one transaction makes the fold all-or-nothing, and
  // skipping the transaction when nothing closed avoids an empty commit every collector tick.
  if (hourly.length > 0 || foldedSampleIds.length > 0) {
    db.transaction((tx) => {
      if (hourly.length > 0) {
        tx.insert(metricSamplesHourly).values(hourly).run();
      }
      for (let i = 0; i < foldedSampleIds.length; i += DELETE_BATCH_SIZE) {
        const batch = foldedSampleIds.slice(i, i + DELETE_BATCH_SIZE);
        tx.delete(metricSamples).where(inArray(metricSamples.id, batch)).run();
      }
    });
  }

  db.delete(metricSamplesHourly).where(lt(metricSamplesHourly.bucketStart, hourlyCutoffIso)).run();
}
