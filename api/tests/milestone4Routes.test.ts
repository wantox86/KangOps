import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { alerts, containers, hosts } from "../src/db/schema.js";

describe("Milestone 4 routes", () => {
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
      .values([
        { dockerId: "c1", hostId: "local", currentName: "web", imageRef: "nginx:1.27", imageDigest: "sha256:aaa", composeProject: "proj", composeService: "web", currentState: "running", currentHealth: "healthy", restartCount: 0, critical: false, firstSeenAt: "t", lastSeenAt: "t" },
        { dockerId: "c2", hostId: "local", currentName: "db", imageRef: "postgres:16", imageDigest: null, composeProject: "proj", composeService: "db", currentState: "running", currentHealth: "healthy", restartCount: 0, critical: false, firstSeenAt: "t", lastSeenAt: "t" },
      ])
      .run();
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
    vi.unstubAllGlobals();
  });

  describe("webhook settings + alerts history", () => {
    it("GET returns disabled defaults with a null masked url", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/settings/webhook" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: false, urlMasked: null, format: "generic", cooldownMinutes: 30 });
    });

    it("PUT persists config and GET never returns the raw url, only a masked host", async () => {
      const putResponse = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/webhook",
        payload: { enabled: true, url: "https://ntfy.sh/my-secret-topic", format: "ntfy", cooldownMinutes: 15 },
      });
      expect(putResponse.statusCode).toBe(200);
      const body = putResponse.json<{ urlMasked: string }>();
      expect(body.urlMasked).toBe("https://ntfy.sh/***");
      expect(body.urlMasked).not.toContain("my-secret-topic");

      const getResponse = await app.inject({ method: "GET", url: "/api/v1/settings/webhook" });
      expect(getResponse.json<{ urlMasked: string }>().urlMasked).toBe("https://ntfy.sh/***");
    });

    it("PUT rejects enabled=true with an empty url", async () => {
      const response = await app.inject({ method: "PUT", url: "/api/v1/settings/webhook", payload: { enabled: true, url: "", format: "generic", cooldownMinutes: 10 } });
      expect(response.statusCode).toBe(400);
    });

    it("GET /api/v1/alerts lists delivery records, most recent first", async () => {
      testDb.db
        .insert(alerts)
        .values([
          { entityType: "container", entityId: "c1", code: "container_unhealthy", severity: "warning", destination: "webhook", status: "sent", summary: "old", dedupeKey: "container:c1:container_unhealthy", sentAt: "2026-01-01T00:00:00.000Z", error: null },
          { entityType: "host", entityId: "local", code: "disk_critical", severity: "critical", destination: "webhook", status: "failed", summary: "new", dedupeKey: "host:local:disk_critical", sentAt: "2026-01-02T00:00:00.000Z", error: "timeout" },
        ])
        .run();

      const response = await app.inject({ method: "GET", url: "/api/v1/alerts" });
      const items = response.json<{ items: Array<{ summary: string; status: string }> }>().items;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ summary: "new", status: "failed" });
    });
  });

  describe("backup targets + backup-result webhook", () => {
    it("creates a target, returns the plaintext token once, and masks it on GET", async () => {
      const createResponse = await app.inject({ method: "POST", url: "/api/v1/backup-targets", payload: { name: "nightly-db", expectedFrequencyMinutes: 60 } });
      expect(createResponse.statusCode).toBe(201);
      const created = createResponse.json<{ id: number; token: string }>();
      expect(created.token).toMatch(/^[0-9a-f]{64}$/);

      const listResponse = await app.inject({ method: "GET", url: "/api/v1/backup-targets" });
      const items = listResponse.json<{ items: Array<{ id: number; tokenMasked: string }> }>().items;
      expect(items).toHaveLength(1);
      expect(items[0]?.tokenMasked).not.toContain(created.token.slice(4));
    });

    it("rejects an invalid create body", async () => {
      const response = await app.inject({ method: "POST", url: "/api/v1/backup-targets", payload: { name: "", expectedFrequencyMinutes: 0 } });
      expect(response.statusCode).toBe(400);
    });

    it("accepts a valid backup-result report and it's reflected in lastSuccessAt", async () => {
      const created = (await app.inject({ method: "POST", url: "/api/v1/backup-targets", payload: { name: "nightly-db", expectedFrequencyMinutes: 60 } })).json<{ token: string }>();

      const reportResponse = await app.inject({ method: "POST", url: `/api/v1/webhooks/backup/${created.token}`, payload: { status: "success" } });
      expect(reportResponse.statusCode).toBe(202);

      const listResponse = await app.inject({ method: "GET", url: "/api/v1/backup-targets" });
      const items = listResponse.json<{ items: Array<{ lastSuccessAt: string | null; lastRunWasFailure: boolean }> }>().items;
      expect(items[0]?.lastSuccessAt).not.toBeNull();
      expect(items[0]?.lastRunWasFailure).toBe(false);
    });

    it("rejects an unknown token with 401", async () => {
      const response = await app.inject({ method: "POST", url: "/api/v1/webhooks/backup/not-a-real-token", payload: { status: "success" } });
      expect(response.statusCode).toBe(401);
    });

    it("rate-limits repeated reports from the same token", async () => {
      const created = (await app.inject({ method: "POST", url: "/api/v1/backup-targets", payload: { name: "flaky", expectedFrequencyMinutes: 60 } })).json<{ token: string }>();

      let lastStatus = 0;
      for (let i = 0; i < 15; i++) {
        const response = await app.inject({ method: "POST", url: `/api/v1/webhooks/backup/${created.token}`, payload: { status: "success" } });
        lastStatus = response.statusCode;
      }
      expect(lastStatus).toBe(429);
    });

    it("deletes a target", async () => {
      const created = (await app.inject({ method: "POST", url: "/api/v1/backup-targets", payload: { name: "temp", expectedFrequencyMinutes: 60 } })).json<{ id: number }>();
      const deleteResponse = await app.inject({ method: "DELETE", url: `/api/v1/backup-targets/${created.id}` });
      expect(deleteResponse.statusCode).toBe(204);

      const listResponse = await app.inject({ method: "GET", url: "/api/v1/backup-targets" });
      expect(listResponse.json<{ items: unknown[] }>().items).toHaveLength(0);
    });
  });

  describe("images / update center", () => {
    it("GET returns locally observed image facts with registry checks disabled by default", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/images" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ registryCheckEnabled: boolean; items: Array<{ imageRef: string; currentDigest: string | null; updateAvailable: boolean | null }> }>();
      expect(body.registryCheckEnabled).toBe(false);
      const web = body.items.find((i) => i.imageRef === "nginx:1.27");
      expect(web).toMatchObject({ currentDigest: "sha256:aaa", updateAvailable: null });
    });

    it("PUT /api/v1/settings/registry toggles the opt-in flag and GET reflects it", async () => {
      const putResponse = await app.inject({ method: "PUT", url: "/api/v1/settings/registry", payload: { enabled: true } });
      expect(putResponse.statusCode).toBe(200);
      const getResponse = await app.inject({ method: "GET", url: "/api/v1/settings/registry" });
      expect(getResponse.json()).toEqual({ enabled: true });
    });
  });

  describe("dependencies", () => {
    it("GET groups co-located containers under a weak/non-causal label", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/dependencies" });
      const body = response.json<{ groups: Array<{ composeProject: string; source: string; confidence: string; note: string; containerIds: string[] }>; annotations: unknown[] }>();
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0]).toMatchObject({ composeProject: "proj", source: "compose_project", confidence: "weak", containerIds: ["c1", "c2"] });
      expect(typeof body.groups[0]?.note).toBe("string");
      expect(body.annotations).toHaveLength(0);
    });

    it("POST creates a declared-confidence annotation and it shows up in GET", async () => {
      const createResponse = await app.inject({ method: "POST", url: "/api/v1/dependencies/annotations", payload: { fromContainerId: "c1", toContainerId: "c2", note: "web calls db" } });
      expect(createResponse.statusCode).toBe(201);
      expect(createResponse.json()).toMatchObject({ source: "user_annotation", confidence: "declared" });

      const listResponse = await app.inject({ method: "GET", url: "/api/v1/dependencies" });
      expect(listResponse.json<{ annotations: unknown[] }>().annotations).toHaveLength(1);
    });

    it("POST rejects an annotation referencing an unknown container", async () => {
      const response = await app.inject({ method: "POST", url: "/api/v1/dependencies/annotations", payload: { fromContainerId: "c1", toContainerId: "nope" } });
      expect(response.statusCode).toBe(404);
    });

    it("DELETE removes an annotation", async () => {
      const created = (await app.inject({ method: "POST", url: "/api/v1/dependencies/annotations", payload: { fromContainerId: "c1", toContainerId: "c2" } })).json<{ id: number }>();
      const deleteResponse = await app.inject({ method: "DELETE", url: `/api/v1/dependencies/annotations/${created.id}` });
      expect(deleteResponse.statusCode).toBe(204);

      const listResponse = await app.inject({ method: "GET", url: "/api/v1/dependencies" });
      expect(listResponse.json<{ annotations: unknown[] }>().annotations).toHaveLength(0);
    });
  });
});
