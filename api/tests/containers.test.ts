import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { containers, events, hosts } from "../src/db/schema.js";

describe("container routes", () => {
  let testDb: TestDb;
  let app: FastifyInstance;

  beforeEach(() => {
    testDb = createTestDb();
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent" });

    testDb.db
      .insert(hosts)
      .values({ id: "local", name: "test", status: "reachable", firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" })
      .run();
    testDb.db
      .insert(containers)
      .values({
        dockerId: "c1",
        hostId: "local",
        currentName: "web",
        imageRef: "nginx:1.27",
        imageDigest: null,
        composeProject: "proj",
        composeService: "web",
        currentState: "running",
        currentHealth: "healthy",
        restartCount: 0,
        critical: false,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    testDb.db
      .insert(events)
      .values({
        hostId: "local",
        containerId: "c1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        source: "collector",
        type: "container_discovered",
        severity: "info",
        summary: "Discovered container \"web\" (running)",
        metadataJson: null,
      })
      .run();
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
  });

  it("GET /api/v1/containers lists persisted containers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/containers" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ containers: Array<{ dockerId: string }> }>();
    expect(body.containers).toHaveLength(1);
    expect(body.containers[0]?.dockerId).toBe("c1");
  });

  it("GET /api/v1/containers excludes removed containers", async () => {
    testDb.db
      .insert(containers)
      .values({
        dockerId: "c-gone",
        hostId: "local",
        currentName: "old-web",
        imageRef: "nginx:1.26",
        imageDigest: null,
        composeProject: "proj",
        composeService: "old-web",
        currentState: "removed",
        currentHealth: "none",
        restartCount: 0,
        critical: false,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    const response = await app.inject({ method: "GET", url: "/api/v1/containers" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ containers: Array<{ dockerId: string; state: string }> }>();
    // The removed row stays in the DB (event history) but must not show up in the list.
    expect(body.containers).toHaveLength(1);
    expect(body.containers.map((c) => c.dockerId)).toEqual(["c1"]);
  });

  it("GET /api/v1/containers/:id returns the container and its events", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/containers/c1" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ container: { dockerId: string }; events: unknown[] }>();
    expect(body.container.dockerId).toBe("c1");
    expect(body.events).toHaveLength(1);
  });

  it("GET /api/v1/containers/:id returns 404 for an unknown id", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/containers/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });
});

describe("summary route", () => {
  let testDb: TestDb;
  let app: FastifyInstance;

  beforeEach(() => {
    testDb = createTestDb();
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent" });
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
  });

  it("returns honest zeros when nothing has been collected yet", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hostCount: 0, containerCounts: { running: 0 } });
  });

  it("reflects persisted container counts", async () => {
    testDb.db
      .insert(hosts)
      .values({ id: "local", name: "test", status: "reachable", firstSeenAt: "t", lastSeenAt: "t" })
      .run();
    testDb.db
      .insert(containers)
      .values([
        {
          dockerId: "c1",
          hostId: "local",
          currentName: "web",
          imageRef: "nginx",
          imageDigest: null,
          composeProject: null,
          composeService: null,
          currentState: "running",
          currentHealth: "healthy",
          restartCount: 0,
          critical: false,
          firstSeenAt: "t",
          lastSeenAt: "t",
        },
        {
          dockerId: "c2",
          hostId: "local",
          currentName: "db",
          imageRef: "mysql",
          imageDigest: null,
          composeProject: null,
          composeService: null,
          currentState: "running",
          currentHealth: "unhealthy",
          restartCount: 0,
          critical: false,
          firstSeenAt: "t",
          lastSeenAt: "t",
        },
      ])
      .run();

    const response = await app.inject({ method: "GET", url: "/api/v1/summary" });
    const body = response.json<{ hostCount: number; containerCounts: { running: number; unhealthy: number } }>();
    expect(body.hostCount).toBe(1);
    expect(body.containerCounts.running).toBe(1);
    expect(body.containerCounts.unhealthy).toBe(1);
  });
});
