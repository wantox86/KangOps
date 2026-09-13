import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { containers, events, hosts, metricSamples } from "../src/db/schema.js";

interface CreatedAgent {
  id: number;
  name: string;
  hostId: string;
  expectedIntervalSeconds: number;
  token: string;
}

const REPORT = {
  agentVersion: "1.0.0",
  hostname: "wawan-bmax",
  kernel: "Linux 7.0.0-27-generic",
  uptimeSeconds: 5_184_000,
  host: { cpuPercent: 12.5, memoryUsedBytes: 1_700_000_000, memoryTotalBytes: 8_150_000_000, diskUsedBytes: 112_000_000_000, diskTotalBytes: 122_000_000_000 },
  containers: [
    { dockerId: "imm1", name: "immich_server", image: "ghcr.io/immich-app/immich-server:v3", imageDigest: "sha256:aaa", state: "running", health: "healthy", composeProject: "immich", composeService: "immich-server" },
  ],
};

describe("Milestone 7 agent routes", () => {
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

  async function createAgent(payload: Record<string, unknown> = { name: "BMAX" }): Promise<CreatedAgent> {
    const response = await app.inject({ method: "POST", url: "/api/v1/agents", payload });
    expect(response.statusCode).toBe(201);
    return response.json<CreatedAgent>();
  }

  describe("registration", () => {
    it("creates an agent, returns the token exactly once, and slugifies the host id", async () => {
      const created = await createAgent({ name: "BMAX Mini PC" });

      expect(created.hostId).toBe("bmax-mini-pc");
      expect(created.token).toMatch(/^[0-9a-f]{64}$/);
      expect(created.expectedIntervalSeconds).toBe(30);

      const list = await app.inject({ method: "GET", url: "/api/v1/agents" });
      const items = list.json<{ items: Array<{ tokenMasked: string; status: string }> }>().items;
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe("pending");
      // Masked, and crucially not the real credential anywhere in a read response.
      expect(items[0]?.tokenMasked).toBe(`${created.token.slice(0, 4)}********`);
      expect(JSON.stringify(items)).not.toContain(created.token);
    });

    it("creates the hosts row up front so a not-yet-deployed agent is still visible", async () => {
      const created = await createAgent();

      const hostRows = testDb.db.select().from(hosts).where(eq(hosts.id, created.hostId)).all();
      expect(hostRows[0]).toMatchObject({ id: "bmax", status: "unknown" });

      const listed = await app.inject({ method: "GET", url: "/api/v1/hosts" });
      expect(listed.json<{ hosts: Array<{ id: string; kind: string }> }>().hosts).toEqual([
        expect.objectContaining({ id: "bmax", kind: "agent", containerCount: 0 }),
      ]);
    });

    it("rejects an invalid body and an out-of-range interval", async () => {
      expect((await app.inject({ method: "POST", url: "/api/v1/agents", payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/v1/agents", payload: { name: "x", expectedIntervalSeconds: 1 } })).statusCode).toBe(400);
    });

    it("deletes an agent registration but keeps its observed history", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });

      expect((await app.inject({ method: "DELETE", url: `/api/v1/agents/${created.id}` })).statusCode).toBe(204);
      expect((await app.inject({ method: "DELETE", url: `/api/v1/agents/${created.id}` })).statusCode).toBe(404);

      // The host and its metric history survive -- only the registration is gone.
      expect(testDb.db.select().from(hosts).all()).toHaveLength(1);
      expect(testDb.db.select().from(metricSamples).all().length).toBeGreaterThan(0);
    });
  });

  describe("POST /api/v1/agents/:token/report", () => {
    it("rejects an unknown token with 401 without revealing whether it exists", async () => {
      const response = await app.inject({ method: "POST", url: "/api/v1/agents/deadbeef/report", payload: REPORT });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: string }>().error).toBe("invalid_token");
    });

    it("validates the payload at the boundary", async () => {
      const created = await createAgent();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${created.token}/report`,
        payload: { agentVersion: "1.0.0", host: { cpuPercent: 900 } },
      });
      expect(response.statusCode).toBe(400);
    });

    it("ingests host metrics, container facts, and marks the host reachable", async () => {
      const created = await createAgent();
      const response = await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });

      expect(response.statusCode).toBe(202);
      expect(response.json<{ containersSynced: number }>().containersSynced).toBe(1);

      const hostRow = testDb.db.select().from(hosts).where(eq(hosts.id, "bmax")).all()[0];
      expect(hostRow?.status).toBe("reachable");
      expect(JSON.parse(hostRow?.metadataJson ?? "{}")).toMatchObject({ kind: "agent", hostname: "wawan-bmax", agentVersion: "1.0.0" });

      const sample = testDb.db.select().from(metricSamples).all()[0];
      expect(sample).toMatchObject({ hostId: "bmax", containerId: null, cpuPercent: 12.5 });

      const containerRow = testDb.db.select().from(containers).all()[0];
      expect(containerRow).toMatchObject({ dockerId: "imm1", hostId: "bmax", currentName: "immich_server", composeProject: "immich" });
    });

    it("surfaces the reported host in GET /hosts with live capacity percentages", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });

      const listed = await app.inject({ method: "GET", url: "/api/v1/hosts" });
      const host = listed.json<{ hosts: Array<{ id: string; kind: string; diskPercent: number | null; containerCount: number; agentVersion: string | null }> }>().hosts[0];

      expect(host).toMatchObject({ id: "bmax", kind: "agent", containerCount: 1, agentVersion: "1.0.0" });
      expect(host?.diskPercent).toBeCloseTo(91.8, 0);
    });

    it("records an agent_online event on the first report but not on every report", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });

      const online = testDb.db.select().from(events).where(eq(events.type, "agent_online")).all();
      expect(online).toHaveLength(1);
    });

    it("emits container lifecycle events for agent-reported state changes", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });
      await app.inject({
        method: "POST",
        url: `/api/v1/agents/${created.token}/report`,
        payload: { ...REPORT, containers: [{ ...REPORT.containers[0], state: "exited", health: "none" }] },
      });

      const types = testDb.db.select().from(events).all().map((e) => e.type);
      expect(types).toContain("container_discovered");
      expect(types).toContain("state_changed");
      expect(testDb.db.select().from(events).all().every((e) => e.source === "agent" || e.type === "agent_online")).toBe(true);
    });

    it("leaves known containers alone when a report omits containers entirely", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });

      const withoutContainers = { ...REPORT } as Record<string, unknown>;
      delete withoutContainers.containers;
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: withoutContainers });

      // "No Docker visibility" must not be confused with "Docker reports zero containers".
      expect(testDb.db.select().from(containers).all()[0]?.currentState).toBe("running");
      expect(testDb.db.select().from(events).all().map((e) => e.type)).not.toContain("container_removed");
    });

    it("marks containers removed when a report contains an empty container list", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: { ...REPORT, containers: [] } });

      expect(testDb.db.select().from(containers).all()[0]?.currentState).toBe("removed");
    });

    it("reports a 'reporting' status once an agent has checked in", async () => {
      const created = await createAgent();
      await app.inject({ method: "POST", url: `/api/v1/agents/${created.token}/report`, payload: REPORT });

      const list = await app.inject({ method: "GET", url: "/api/v1/agents" });
      expect(list.json<{ items: Array<{ status: string; agentVersion: string }> }>().items[0]).toMatchObject({ status: "reporting", agentVersion: "1.0.0" });
    });
  });
});
