import { describe, expect, it } from "vitest";
import { downsampleToHourly } from "../src/metrics/retention.js";
import type { MetricSample } from "../src/db/schema.js";

function sample(overrides: Partial<MetricSample>): MetricSample {
  return {
    id: 1,
    hostId: "local",
    containerId: null,
    observedAt: "2026-01-01T00:00:00.000Z",
    cpuPercent: 10,
    memoryBytes: 1000,
    memoryLimitBytes: 2000,
    diskUsedBytes: null,
    diskTotalBytes: null,
    ...overrides,
  };
}

describe("downsampleToHourly", () => {
  it("leaves samples at/after the cutoff untouched", () => {
    const result = downsampleToHourly([sample({ id: 1, observedAt: "2026-01-05T00:00:00.000Z" })], "2026-01-01T00:00:00.000Z");
    expect(result.hourly).toHaveLength(0);
    expect(result.foldedSampleIds).toHaveLength(0);
  });

  it("folds samples in the same host+hour into a single rollup row", () => {
    const samples = [
      sample({ id: 1, observedAt: "2026-01-01T00:00:10.000Z", cpuPercent: 10, memoryBytes: 1000 }),
      sample({ id: 2, observedAt: "2026-01-01T00:20:00.000Z", cpuPercent: 30, memoryBytes: 3000 }),
    ];
    const result = downsampleToHourly(samples, "2026-01-02T00:00:00.000Z");
    expect(result.hourly).toHaveLength(1);
    expect(result.hourly[0]).toMatchObject({
      hostId: "local",
      containerId: null,
      bucketStart: "2026-01-01T00:00:00.000Z",
      sampleCount: 2,
      avgCpuPercent: 20,
      maxCpuPercent: 30,
      avgMemoryBytes: 2000,
      maxMemoryBytes: 3000,
    });
    expect(result.foldedSampleIds.sort()).toEqual([1, 2]);
  });

  it("keeps different hours as separate buckets", () => {
    const samples = [
      sample({ id: 1, observedAt: "2026-01-01T00:10:00.000Z" }),
      sample({ id: 2, observedAt: "2026-01-01T01:10:00.000Z" }),
    ];
    const result = downsampleToHourly(samples, "2026-01-02T00:00:00.000Z");
    expect(result.hourly).toHaveLength(2);
  });

  it("keeps different containers (including host-level null) as separate buckets", () => {
    const samples = [
      sample({ id: 1, containerId: null, observedAt: "2026-01-01T00:10:00.000Z" }),
      sample({ id: 2, containerId: "c1", observedAt: "2026-01-01T00:10:00.000Z" }),
    ];
    const result = downsampleToHourly(samples, "2026-01-02T00:00:00.000Z");
    expect(result.hourly).toHaveLength(2);
    expect(new Set(result.hourly.map((h) => h.containerId))).toEqual(new Set([null, "c1"]));
  });

  it("ignores null metric values instead of treating them as zero", () => {
    const samples = [
      sample({ id: 1, cpuPercent: null, memoryBytes: 1000 }),
      sample({ id: 2, cpuPercent: 40, memoryBytes: null }),
    ];
    const result = downsampleToHourly(samples, "2026-01-02T00:00:00.000Z");
    expect(result.hourly[0]).toMatchObject({ avgCpuPercent: 40, avgMemoryBytes: 1000 });
  });

  it("returns empty results for an empty input", () => {
    const result = downsampleToHourly([], "2026-01-02T00:00:00.000Z");
    expect(result).toEqual({ hourly: [], foldedSampleIds: [] });
  });
});
