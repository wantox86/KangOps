import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import type { FastifyInstance } from "fastify";

describe("health routes", () => {
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

  it("GET /healthz returns ok without touching the database", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz returns ok when the database is reachable", async () => {
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("suppresses info-level request logs on /healthz and /readyz when global logLevel is info", async () => {
    const infoApp = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "info" });
    try {
      const seenLevels = new Map<string, string>();
      infoApp.addHook("onRequest", async (request) => {
        seenLevels.set(request.url, request.log.level);
      });

      const healthz = await infoApp.inject({ method: "GET", url: "/healthz" });
      const readyz = await infoApp.inject({ method: "GET", url: "/readyz" });
      expect(healthz.statusCode).toBe(200);
      expect(readyz.statusCode).toBe(200);
      expect(seenLevels.get("/healthz")).toBe("warn");
      expect(seenLevels.get("/readyz")).toBe("warn");
    } finally {
      await infoApp.close();
    }
  });

  it("keeps silent logLevel on /healthz and /readyz when global logLevel is silent", async () => {
    const seenLevels = new Map<string, string>();
    app.addHook("onRequest", async (request) => {
      seenLevels.set(request.url, request.log.level);
    });

    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/readyz" });
    expect(seenLevels.get("/healthz")).toBe("silent");
    expect(seenLevels.get("/readyz")).toBe("silent");
  });
});
