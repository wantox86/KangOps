import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { PORTAL_CATALOG } from "../src/portal/catalog.js";

describe("portal routes", () => {
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

  it("GET /api/v1/portal returns the catalog grouped, with no entries lost", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/portal" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ groups: Array<{ id: string; title: string; entries: Array<{ name: string }> }> }>();

    // Every catalog entry appears in exactly one group -- grouping must not silently drop rows.
    const flat = body.groups.flatMap((g) => g.entries.map((e) => e.name));
    expect(flat).toHaveLength(PORTAL_CATALOG.length);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("puts the public (tunnel) group first and keeps LAN groups per host", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/portal" });
    const body = response.json<{ groups: Array<{ id: string }> }>();
    expect(body.groups[0]?.id).toBe("public");
    expect(body.groups.map((g) => g.id)).toEqual(["public", "lan-macmini", "lan-bmax", "lan-hpmini"]);
  });

  it("keeps dead entries listed (with status flag) instead of hiding them", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/portal" });
    const body = response.json<{ groups: Array<{ entries: Array<{ name: string; status: string }> }> }>();
    const dead = body.groups.flatMap((g) => g.entries).filter((e) => e.status === "dead");
    // Ollama is intentionally kept visible as a dead tunnel hostname.
    expect(dead.some((e) => e.name === "Ollama")).toBe(true);
  });

  it("marks every public entry with a tunnel URL and every entry with a host/runtime", async () => {
    for (const entry of PORTAL_CATALOG) {
      expect(["macmini", "bmax", "hpmini"]).toContain(entry.host);
      expect(["docker", "native"]).toContain(entry.runtime);
      if (entry.exposure === "public" && entry.status === "live") {
        expect(entry.url?.startsWith("https://")).toBe(true);
      }
    }
  });
});
