import type { MetricSample, NewMetricSampleHourly } from "../db/schema.js";

export interface RetentionConfig {
  // Raw samples older than this are downsampled into metric_samples_hourly, then deleted --
  // keeps metric_samples bounded regardless of collector interval or how long the box runs.
  rawRetentionMs: number;
  // Hourly rollups older than this are deleted outright (no further downsampling tier --
  // per CLAUDE.md's "avoid overengineering", a two-tier raw/hourly scheme is enough for a
  // single-homelab-host MVP).
  hourlyRetentionMs: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  rawRetentionMs: 24 * 60 * 60 * 1000, // 24h of raw samples
  hourlyRetentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days of hourly rollups
};

const HOUR_MS = 60 * 60 * 1000;

function entityKey(sample: MetricSample): string {
  return `${sample.hostId}:${sample.containerId ?? ""}`;
}

function truncateToHourMs(iso: string): number {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function max(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

// Pure: groups raw samples into one hourly rollup row per (host, container, hour).
//
// A bucket is folded only once it is *fully* older than the cutoff (bucketStart + 1h <= cutoff),
// never while it is still open. Folding partially-elapsed buckets is what previously caused
// unbounded duplicate rows: the cutoff advances on every collector cycle (~20s), so an open hour
// kept getting re-folded, each pass emitting another single-sample rollup row for the same
// (entity, bucket). Waiting for the bucket to close means all of that hour's raw samples are
// already present, so it folds into exactly one row; the caller then deletes those raw rows and
// the bucket can never reappear (new samples always carry a current timestamp), so it can never
// be double-counted. Net effect: raw samples live for the raw window *plus* up to one hour, until
// their hour closes -- still bounded and cheap. Callers (metrics/runRetention.ts) are responsible
// for reading rows in, calling this, writing the rollups out, and deleting the raw rows folded in.
export function downsampleToHourly(samples: MetricSample[], cutoffIso: string): { hourly: NewMetricSampleHourly[]; foldedSampleIds: number[] } {
  const cutoffMs = new Date(cutoffIso).getTime();

  const groups = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const bucketStartMs = truncateToHourMs(sample.observedAt);
    if (bucketStartMs + HOUR_MS > cutoffMs) continue; // hour not closed yet -- leave raw
    const key = `${entityKey(sample)}:${bucketStartMs}`;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }

  const hourly: NewMetricSampleHourly[] = [];
  const foldedSampleIds: number[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const cpuValues = group.map((s) => s.cpuPercent).filter((v): v is number => v !== null);
    const memValues = group.map((s) => s.memoryBytes).filter((v): v is number => v !== null);
    const diskValues = group.map((s) => s.diskUsedBytes).filter((v): v is number => v !== null);

    hourly.push({
      hostId: first.hostId,
      containerId: first.containerId,
      bucketStart: new Date(truncateToHourMs(first.observedAt)).toISOString(),
      sampleCount: group.length,
      avgCpuPercent: avg(cpuValues),
      maxCpuPercent: max(cpuValues),
      avgMemoryBytes: memValues.length > 0 ? Math.round(avg(memValues) as number) : null,
      maxMemoryBytes: max(memValues),
      memoryLimitBytes: last(group.map((s) => s.memoryLimitBytes).filter((v): v is number => v !== null)) ?? null,
      avgDiskUsedBytes: diskValues.length > 0 ? Math.round(avg(diskValues) as number) : null,
      diskTotalBytes: last(group.map((s) => s.diskTotalBytes).filter((v): v is number => v !== null)) ?? null,
    });
    for (const s of group) foldedSampleIds.push(s.id);
  }

  return { hourly, foldedSampleIds };
}
