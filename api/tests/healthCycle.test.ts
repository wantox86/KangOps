import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { startCollector, type Collector } from "../src/collector/loop.js";
import { createFixtureAdapter } from "../src/docker/fixtureAdapter.js";
import { healthConditions, metricSamples } from "../src/db/schema.js";

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} } as unknown as import("fastify").FastifyBaseLogger;

// Exercises the health/metrics cycle the way it actually runs -- wired into the collector loop
// (see collector/loop.ts) rather than called standalone, so this is the integration test that
// proves the wiring (not just the pure engine/reconcile/retention pieces tested elsewhere).
describe("collector loop's health/metrics cycle", () => {
  let testDb: TestDb;
  let collector: Collector | undefined;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    collector?.stop();
    testDb.close();
  });

  it("persists a host metric sample and a container metric sample per cycle", async () => {
    collector = startCollector({
      db: testDb.db,
      adapter: createFixtureAdapter(),
      hostId: "local",
      hostName: "test-host",
      intervalMs: 60_000,
      timeoutMs: 1000,
      retries: 0,
      logger: silentLogger,
      // CI sandboxes can restrict statfs on arbitrary paths -- host metrics collection already
      // tolerates that (see host/metrics.ts), so this just documents the same tolerance here.
      diskPath: "/",
    });

    await collector.runOnce();

    const samples = testDb.db.select().from(metricSamples).all();
    const hostSamples = samples.filter((s) => s.containerId === null);
    const containerSamples = samples.filter((s) => s.containerId !== null);
    expect(hostSamples.length).toBeGreaterThan(0);
    // Fixture stats.json only has entries for 2 of the 3 fixture containers, and getStats is
    // only called for currently-running ones -- so this is "some", not "one per container".
    expect(containerSamples.length).toBeGreaterThan(0);
  });

  it("flags critical_container_down once a container is marked critical and is stopped", async () => {
    collector = startCollector({
      db: testDb.db,
      adapter: createFixtureAdapter(),
      hostId: "local",
      hostName: "test-host",
      intervalMs: 60_000,
      timeoutMs: 1000,
      retries: 0,
      logger: silentLogger,
    });

    // First cycle discovers containers (including the fixture's exited translateidbot-mysql).
    await collector.runOnce();
    const { containers } = await import("../src/db/schema.js");
    testDb.db.update(containers).set({ critical: true }).where(eq(containers.dockerId, "c3d4e5f6a1b2")).run();

    // Second cycle should now evaluate that container as critical+down.
    await collector.runOnce();

    const active = testDb.db.select().from(healthConditions).where(eq(healthConditions.active, true)).all();
    const found = active.find((c) => c.code === "critical_container_down" && c.entityId === "c3d4e5f6a1b2");
    expect(found).toBeDefined();
  });

  it("marking the same container non-critical again resolves the condition", async () => {
    collector = startCollector({
      db: testDb.db,
      adapter: createFixtureAdapter(),
      hostId: "local",
      hostName: "test-host",
      intervalMs: 60_000,
      timeoutMs: 1000,
      retries: 0,
      logger: silentLogger,
    });

    const { containers } = await import("../src/db/schema.js");
    await collector.runOnce();
    testDb.db.update(containers).set({ critical: true }).where(eq(containers.dockerId, "c3d4e5f6a1b2")).run();
    await collector.runOnce();
    testDb.db.update(containers).set({ critical: false }).where(eq(containers.dockerId, "c3d4e5f6a1b2")).run();
    await collector.runOnce();

    const rows = testDb.db.select().from(healthConditions).where(eq(healthConditions.code, "critical_container_down")).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.active === false)).toBe(true);
    expect(rows.some((r) => r.resolvedAt !== null)).toBe(true);
  });
});
