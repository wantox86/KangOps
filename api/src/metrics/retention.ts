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

function entityKey(sample: MetricSample): string {
  return `${sample.hostId}:${sample.containerId ?? ""}`;
}

function truncateToHour(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
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

// Pure: groups raw samples older than the cutoff into one hourly rollup row per
// (host, container, hour). Samples at/after the cutoff are left alone (still "raw"). Callers
// (metrics/runRetention.ts) are responsible for reading rows in, calling this, writing the
// rollups out, and deleting the raw rows that got folded in.
export function downsampleToHourly(samples: MetricSample[], cutoffIso: string): { hourly: NewMetricSampleHourly[]; foldedSampleIds: number[] } {
  const eligible = samples.filter((s) => s.observedAt < cutoffIso);
  if (eligible.length === 0) return { hourly: [], foldedSampleIds: [] };

  const groups = new Map<string, MetricSample[]>();
  for (const sample of eligible) {
    const bucket = truncateToHour(sample.observedAt);
    const key = `${entityKey(sample)}:${bucket}`;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }

  const hourly: NewMetricSampleHourly[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const cpuValues = group.map((s) => s.cpuPercent).filter((v): v is number => v !== null);
    const memValues = group.map((s) => s.memoryBytes).filter((v): v is number => v !== null);
    const diskValues = group.map((s) => s.diskUsedBytes).filter((v): v is number => v !== null);

    hourly.push({
      hostId: first.hostId,
      containerId: first.containerId,
      bucketStart: truncateToHour(first.observedAt),
      sampleCount: group.length,
      avgCpuPercent: avg(cpuValues),
      maxCpuPercent: max(cpuValues),
      avgMemoryBytes: memValues.length > 0 ? Math.round(avg(memValues) as number) : null,
      maxMemoryBytes: max(memValues),
      memoryLimitBytes: last(group.map((s) => s.memoryLimitBytes).filter((v): v is number => v !== null)) ?? null,
      avgDiskUsedBytes: diskValues.length > 0 ? Math.round(avg(diskValues) as number) : null,
      diskTotalBytes: last(group.map((s) => s.diskTotalBytes).filter((v): v is number => v !== null)) ?? null,
    });
  }

  return { hourly, foldedSampleIds: eligible.map((s) => s.id) };
}
