import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { startCollector, type Collector } from "../src/collector/loop.js";
import { createFixtureAdapter } from "../src/docker/fixtureAdapter.js";
import { containers, events, hosts } from "../src/db/schema.js";
import type { DockerReadAdapter, NormalizedContainer } from "../src/docker/types.js";

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as import("fastify").FastifyBaseLogger;

describe("collector loop", () => {
  let testDb: TestDb;
  let collector: Collector | undefined;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    collector?.stop();
    testDb.close();
  });

  it("persists containers and a discovery event on the first cycle", async () => {
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

    await collector.runOnce();

    const rows = testDb.db.select().from(containers).all();
    expect(rows.length).toBe(3);

    const discoveryEvents = testDb.db.select().from(events).where(eq(events.type, "container_discovered")).all();
    expect(discoveryEvents.length).toBe(3);

    const host = testDb.db.select().from(hosts).where(eq(hosts.id, "local")).all()[0];
    expect(host?.status).toBe("reachable");
  });

  it("does not re-emit discovery events on a second identical cycle", async () => {
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

    await collector.runOnce();
    await collector.runOnce();

    const rows = testDb.db.select().from(events).all();
    expect(rows.length).toBe(3);
  });

  it("marks the host unreachable and records a collector_error event when the adapter fails", async () => {
    const failingAdapter: DockerReadAdapter = {
      listContainers(): Promise<NormalizedContainer[]> {
        return Promise.reject(new Error("connection refused"));
      },
      getStats(): Promise<null> {
        return Promise.resolve(null);
      },
    };

    collector = startCollector({
      db: testDb.db,
      adapter: failingAdapter,
      hostId: "local",
      hostName: "test-host",
      intervalMs: 60_000,
      timeoutMs: 1000,
      retries: 1,
      logger: silentLogger,
    });

    await collector.runOnce();

    const host = testDb.db.select().from(hosts).where(eq(hosts.id, "local")).all()[0];
    expect(host?.status).toBe("unreachable");

    const errorEvents = testDb.db.select().from(events).where(eq(events.type, "collector_error")).all();
    expect(errorEvents.length).toBe(1);
  });

  it("times out a hung adapter call instead of hanging forever", async () => {
    const hungAdapter: DockerReadAdapter = {
      listContainers(): Promise<NormalizedContainer[]> {
        return new Promise(() => {
          // never resolves
        });
      },
      getStats(): Promise<null> {
        return Promise.resolve(null);
      },
    };

    collector = startCollector({
      db: testDb.db,
      adapter: hungAdapter,
      hostId: "local",
      hostName: "test-host",
      intervalMs: 60_000,
      timeoutMs: 50,
      retries: 0,
      logger: silentLogger,
    });

    await collector.runOnce();

    const host = testDb.db.select().from(hosts).where(eq(hosts.id, "local")).all()[0];
    expect(host?.status).toBe("unreachable");
  }, 2000);
});
