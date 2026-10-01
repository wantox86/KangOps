import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
import { downsampleToHourly } from "../src/metrics/retention.js";
import { runRetention } from "../src/metrics/runRetention.js";
import type { MetricSample } from "../src/db/schema.js";
import { hosts, metricSamples, metricSamplesHourly } from "../src/db/schema.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";

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

  // Regression (2026-10-01): the old filter folded any sample older than the cutoff, so an
  // hour still in progress got re-folded on every collector cycle (the cutoff slides ~20s each
  // tick), each pass emitting another single-sample rollup row for the same (entity, bucket).
  // That is what ballooned metric_samples_hourly to ~585k near-identical rows.
  it("does not fold a bucket while its hour is still open", () => {
    // Sample at 00:00:10 sits inside the 00:00 hour. A cutoff of 00:59 is *after* the sample
    // (so the old code would have folded it) but *before* the hour closes at 01:00.
    const result = downsampleToHourly([sample({ id: 1, observedAt: "2026-01-01T00:00:10.000Z" })], "2026-01-01T00:59:00.000Z");
    expect(result.hourly).toHaveLength(0);
    expect(result.foldedSampleIds).toHaveLength(0);
  });

  it("folds a bucket once its hour has fully closed", () => {
    const result = downsampleToHourly([sample({ id: 1, observedAt: "2026-01-01T00:00:10.000Z" })], "2026-01-01T01:00:00.000Z");
    expect(result.hourly).toHaveLength(1);
    expect(result.hourly[0]).toMatchObject({ bucketStart: "2026-01-01T00:00:00.000Z", sampleCount: 1 });
    expect(result.foldedSampleIds).toEqual([1]);
  });
});

// End-to-end guard for the same regression: repeated collector cycles with a sliding cutoff must
// never produce more than one rollup row per (entity, hour), and must leave the in-progress hour
//'s raw samples alone.
describe("runRetention across repeated cycles (no duplicate rollups)", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    const now = "2026-01-01T00:00:00.000Z";
    testDb.db.insert(hosts).values({ id: "local", name: "test-host", status: "unknown", firstSeenAt: now, lastSeenAt: now }).run();
  });

  afterEach(() => {
    testDb.close();
  });

  function insertRaw(id: number, observedAt: string): void {
    testDb.db
      .insert(metricSamples)
      .values({ id, hostId: "local", containerId: null, observedAt, cpuPercent: 10, memoryBytes: 1000, memoryLimitBytes: 2000 })
      .run();
  }

  it("folds a closed hour exactly once while a later cycle advances the cutoff", () => {
    // Hour 00:00 already fully closed relative to both cutoffs below (bucket ends 01:00).
    for (let i = 0; i < 5; i++) insertRaw(i + 1, `2026-01-01T00:${String(i * 10).padStart(2, "0")}:00.000Z`);

    // Cycle at 01:00:10 -- hour 00:00 has closed (01:00 <= 01:00:10 - 24h? no: use explicit config).
    const config = { rawRetentionMs: 0, hourlyRetentionMs: 30 * 24 * 60 * 60 * 1000 };
    runRetention(testDb.db, "2026-01-01T01:00:10.000Z", config);
    runRetention(testDb.db, "2026-01-01T01:00:30.000Z", config);
    runRetention(testDb.db, "2026-01-01T01:00:50.000Z", config);

    const rows = testDb.db.select().from(metricSamplesHourly).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostId: "local", containerId: null, bucketStart: "2026-01-01T00:00:00.000Z", sampleCount: 5 });
    // Raw rows for the folded hour are gone; the table is otherwise empty.
    expect(testDb.db.select().from(metricSamples).all()).toHaveLength(0);
  });

  it("leaves the in-progress hour's raw samples raw", () => {
    insertRaw(1, "2026-01-01T01:30:00.000Z"); // still inside the 01:00 hour
    const config = { rawRetentionMs: 0, hourlyRetentionMs: 30 * 24 * 60 * 60 * 1000 };
    runRetention(testDb.db, "2026-01-01T01:45:00.000Z", config);
    runRetention(testDb.db, "2026-01-01T01:59:59.000Z", config);

    expect(testDb.db.select().from(metricSamplesHourly).all()).toHaveLength(0);
    const raw = testDb.db.select().from(metricSamples).orderBy(desc(metricSamples.id)).all();
    expect(raw).toHaveLength(1);
  });
});
