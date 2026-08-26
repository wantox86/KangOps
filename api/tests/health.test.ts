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
});
