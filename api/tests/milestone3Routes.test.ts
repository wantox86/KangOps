import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { containers, events, healthConditions, hosts, metricSamples } from "../src/db/schema.js";
import { DEFAULT_THRESHOLDS } from "../src/health/types.js";

describe("Milestone 3 routes", () => {
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
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
  });

  describe("settings", () => {
    it("GET returns defaults when nothing has been saved", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(DEFAULT_THRESHOLDS);
    });

    it("PUT validates and persists thresholds, then GET reflects them", async () => {
      const updated = { ...DEFAULT_THRESHOLDS, cpuWarningPercent: 50 };
      const putResponse = await app.inject({ method: "PUT", url: "/api/v1/settings", payload: updated });
      expect(putResponse.statusCode).toBe(200);

      const getResponse = await app.inject({ method: "GET", url: "/api/v1/settings" });
      expect(getResponse.json<typeof updated>().cpuWarningPercent).toBe(50);
    });

    it("PUT rejects an invalid body (healthyMinScore <= attentionMinScore)", async () => {
      const invalid = { ...DEFAULT_THRESHOLDS, healthyMinScore: 40, attentionMinScore: 50 };
      const response = await app.inject({ method: "PUT", url: "/api/v1/settings", payload: invalid });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("container critical flag", () => {
    it("PATCH sets critical=true and it round-trips through GET", async () => {
      const patchResponse = await app.inject({ method: "PATCH", url: "/api/v1/containers/c1", payload: { critical: true } });
      expect(patchResponse.statusCode).toBe(200);
      expect(patchResponse.json<{ critical: boolean }>().critical).toBe(true);

      const getResponse = await app.inject({ method: "GET", url: "/api/v1/containers/c1" });
      expect(getResponse.json<{ container: { critical: boolean } }>().container.critical).toBe(true);
    });

    it("PATCH returns 404 for an unknown container", async () => {
      const response = await app.inject({ method: "PATCH", url: "/api/v1/containers/nope", payload: { critical: true } });
      expect(response.statusCode).toBe(404);
    });

    it("PATCH returns 400 for an invalid body", async () => {
      const response = await app.inject({ method: "PATCH", url: "/api/v1/containers/c1", payload: { critical: "yes" } });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("health + attention", () => {
    it("GET /api/v1/health reports a perfect score with no active conditions", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "healthy", score: 100, conditions: [] });
    });

    it("GET /api/v1/attention lists active conditions with evidence, sorted by severity", async () => {
      testDb.db
        .insert(healthConditions)
        .values([
          {
            entityType: "container",
            entityId: "c1",
            code: "container_cpu_high",
            severity: "warning",
            penalty: 10,
            active: true,
            summary: "CPU high",
            detectedAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: null,
            evidenceJson: JSON.stringify({ cpuPercent: 91 }),
          },
          {
            entityType: "host",
            entityId: "local",
            code: "collector_unavailable",
            severity: "critical",
            penalty: 20,
            active: true,
            summary: "Host unreachable",
            detectedAt: "2026-01-01T00:00:01.000Z",
            resolvedAt: null,
            evidenceJson: null,
          },
          {
            entityType: "container",
            entityId: "c1",
            code: "resolved_thing",
            severity: "warning",
            penalty: 5,
            active: false,
            summary: "already resolved",
            detectedAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: "2026-01-01T00:05:00.000Z",
            evidenceJson: null,
          },
        ])
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/attention" });
      const body = response.json<{ items: Array<{ code: string; evidence: unknown }> }>();
      expect(body.items).toHaveLength(2);
      expect(body.items[0]?.code).toBe("collector_unavailable");
      expect(body.items[1]?.evidence).toEqual({ cpuPercent: 91 });
    });
  });

  describe("events timeline", () => {
    it("GET /api/v1/events returns events across containers, most recent first", async () => {
      testDb.db
        .insert(events)
        .values([
          { hostId: "local", containerId: "c1", occurredAt: "2026-01-01T00:00:00.000Z", source: "collector", type: "container_discovered", severity: "info", summary: "first", metadataJson: null },
          { hostId: "local", containerId: null, occurredAt: "2026-01-01T00:01:00.000Z", source: "collector", type: "collector_error", severity: "critical", summary: "second", metadataJson: null },
        ])
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/events" });
      const body = response.json<{ events: Array<{ summary: string }> }>();
      expect(body.events).toHaveLength(2);
      expect(body.events[0]?.summary).toBe("second");
    });

    it("respects the limit query param", async () => {
      testDb.db
        .insert(events)
        .values([
          { hostId: "local", containerId: null, occurredAt: "2026-01-01T00:00:00.000Z", source: "collector", type: "a", severity: "info", summary: "a", metadataJson: null },
          { hostId: "local", containerId: null, occurredAt: "2026-01-01T00:01:00.000Z", source: "collector", type: "b", severity: "info", summary: "b", metadataJson: null },
        ])
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/events?limit=1" });
      expect(response.json<{ events: unknown[] }>().events).toHaveLength(1);
    });
  });

  describe("metrics charts", () => {
    it("returns raw points for a short range", async () => {
      testDb.db
        .insert(metricSamples)
        .values({
          hostId: "local",
          containerId: "c1",
          observedAt: new Date().toISOString(),
          cpuPercent: 12.5,
          memoryBytes: 1000,
          memoryLimitBytes: 2000,
          diskUsedBytes: null,
          diskTotalBytes: null,
        })
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/containers/c1/metrics?range=1h" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ resolution: string; points: Array<{ cpuPercent: number }> }>();
      expect(body.resolution).toBe("raw");
      expect(body.points).toHaveLength(1);
      expect(body.points[0]?.cpuPercent).toBe(12.5);
    });

    it("returns an empty points array (not an error) when there's no data yet", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/containers/c1/metrics" });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ points: unknown[] }>().points).toEqual([]);
    });

    it("supports host-level metrics too", async () => {
      testDb.db
        .insert(metricSamples)
        .values({
          hostId: "local",
          containerId: null,
          observedAt: new Date().toISOString(),
          cpuPercent: 5,
          memoryBytes: 500,
          memoryLimitBytes: 1000,
          diskUsedBytes: 100,
          diskTotalBytes: 1000,
        })
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/hosts/local/metrics?range=1h" });
      expect(response.json<{ points: unknown[] }>().points).toHaveLength(1);
    });
  });

  describe("hosts list", () => {
    it("returns persisted hosts", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/hosts" });
      expect(response.json<{ hosts: Array<{ id: string }> }>().hosts).toHaveLength(1);
    });
  });

  describe("summary reflects real health engine output", () => {
    it("degrades status/score once an active health condition exists", async () => {
      testDb.db
        .insert(healthConditions)
        .values({
          entityType: "container",
          entityId: "c1",
          code: "critical_container_down",
          severity: "critical",
          penalty: 35,
          active: true,
          summary: "Critical container down",
          detectedAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          evidenceJson: null,
        })
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/summary" });
      const body = response.json<{ healthStatus: string; healthScore: number; reasons: string[] }>();
      expect(body.healthScore).toBe(65);
      expect(body.healthStatus).toBe("attention");
      expect(body.reasons).toContain("Critical container down");
    });
  });
});
