import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { containers, events, hosts } from "../src/db/schema.js";
import type { DockerControlAdapter } from "../src/docker/types.js";

function seedContainer(testDb: TestDb, hostId: string, dockerId: string): void {
  testDb.db
    .insert(hosts)
    .values({ id: hostId, name: hostId, status: "reachable", firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" })
    .onConflictDoNothing()
    .run();
  testDb.db
    .insert(containers)
    .values({
      dockerId,
      hostId,
      currentName: "web",
      imageRef: "nginx:1.27",
      imageDigest: null,
      composeProject: null,
      composeService: null,
      currentState: "running",
      currentHealth: "healthy",
      restartCount: 0,
      critical: false,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
}

describe("container control routes", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let adapter: DockerControlAdapter;

  beforeEach(() => {
    testDb = createTestDb();
    adapter = {
      startContainer: vi.fn().mockResolvedValue(undefined),
      stopContainer: vi.fn().mockResolvedValue(undefined),
      restartContainer: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
  });

  it("returns 501 when control is not enabled (no adapter wired)", async () => {
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent" });
    seedContainer(testDb, "local", "c1");

    const response = await app.inject({ method: "POST", url: "/api/v1/containers/c1/restart" });
    expect(response.statusCode).toBe(501);
  });

  it("returns 404 for an unknown container id", async () => {
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent", controlAdapter: adapter });

    const response = await app.inject({ method: "POST", url: "/api/v1/containers/does-not-exist/restart" });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a container on a non-local (agent) host", async () => {
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent", controlAdapter: adapter });
    seedContainer(testDb, "bmax", "c-remote");

    const response = await app.inject({ method: "POST", url: "/api/v1/containers/c-remote/restart" });
    expect(response.statusCode).toBe(400);
    expect(adapter.restartContainer).not.toHaveBeenCalled();
  });

  it.each(["start", "stop", "restart"] as const)("calls the adapter's %s method and records a success audit event", async (action) => {
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent", controlAdapter: adapter });
    seedContainer(testDb, "local", "c1");

    const response = await app.inject({ method: "POST", url: `/api/v1/containers/c1/${action}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, action, dockerId: "c1" });

    const methodName = `${action}Container` as const;
    expect(adapter[methodName]).toHaveBeenCalledWith("c1");

    const rows = testDb.db.select().from(events).all();
    const auditRow = rows.find((r) => r.source === "container_control");
    expect(auditRow).toMatchObject({ type: `container_${action}`, severity: "info", containerId: "c1" });
  });

  it("returns 502 and records a failure audit event when the adapter throws", async () => {
    adapter.restartContainer = vi.fn().mockRejectedValue(new Error("docker daemon unreachable"));
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent", controlAdapter: adapter });
    seedContainer(testDb, "local", "c1");

    const response = await app.inject({ method: "POST", url: "/api/v1/containers/c1/restart" });
    expect(response.statusCode).toBe(502);

    const rows = testDb.db.select().from(events).all();
    const auditRow = rows.find((r) => r.source === "container_control");
    expect(auditRow).toMatchObject({ type: "container_restart", severity: "warning" });
    expect(auditRow?.summary).toContain("docker daemon unreachable");
  });
});
