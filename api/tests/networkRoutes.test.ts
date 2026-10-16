import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { networkDevices } from "../src/db/schema.js";
import { MAX_UNALIASED_DEVICES, OFFLINE_RETENTION_MS, pruneNetworkDevices } from "../src/network/repo.js";

const A = "02:00:00:00:00:01";
const B = "02:00:00:00:00:02";
const C = "02:00:00:00:00:03";

interface DeviceView {
  mac: string;
  ip: string | null;
  hostname: string | null;
  vendor: string | null;
  alias: string | null;
  name: string | null;
  online: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}
interface ListResponse {
  items: DeviceView[];
  onlineCount: number;
  totalCount: number;
  lastSnapshotAt: string | null;
  stale: boolean;
}

describe("network devices", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    testDb = createTestDb();
    app = buildApp({ sqlite: testDb.sqlite, db: testDb.db, logLevel: "silent" });
    const created = await app.inject({ method: "POST", url: "/api/v1/agents", payload: { name: "BMAX" } });
    token = created.json<{ token: string }>().token;
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
  });

  const snapshot = (devices: Array<Record<string, unknown>>) => ({ collectorVersion: "1.0.0", devices });
  const post = (devices: Array<Record<string, unknown>>, t = token) =>
    app.inject({ method: "POST", url: `/api/v1/agents/${t}/network`, payload: snapshot(devices) });
  const list = async () => (await app.inject({ method: "GET", url: "/api/v1/network/devices" })).json<ListResponse>();

  describe("auth", () => {
    it("rejects an unknown token with 401 and stores nothing", async () => {
      const res = await post([{ mac: A }], "0".repeat(64));
      expect(res.statusCode).toBe(401);
      expect((await list()).totalCount).toBe(0);
    });

    it("rejects a disabled agent with 403", async () => {
      testDb.sqlite.prepare("UPDATE agents SET enabled = 0").run();
      expect((await post([{ mac: A }])).statusCode).toBe(403);
    });

    it("rejects an invalid body with 400", async () => {
      expect((await post([{ mac: "not-a-mac" }])).statusCode).toBe(400);
      const noVersion = await app.inject({ method: "POST", url: `/api/v1/agents/${token}/network`, payload: { devices: [] } });
      expect(noVersion.statusCode).toBe(400);
    });
  });

  describe("ingest", () => {
    it("creates devices, normalises MACs, and reports counts", async () => {
      const res = await post([
        { mac: A.toLowerCase().replace(/:/g, "-"), ip: "192.168.50.20", hostname: "laptop", vendor: "ExampleCorp" },
        { mac: B, ip: "192.168.50.21", hostname: "  ", vendor: null },
      ]);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ recorded: true, online: 2, newDevices: 2, markedOffline: 0 });

      const body = await list();
      expect(body.onlineCount).toBe(2);
      expect(body.stale).toBe(false);
      expect(body.lastSnapshotAt).not.toBeNull();
      const a = body.items.find((d) => d.mac === A);
      expect(a).toMatchObject({ ip: "192.168.50.20", hostname: "laptop", vendor: "ExampleCorp", online: true, name: "laptop" });
      // Blank hostname becomes null rather than an empty string.
      expect(body.items.find((d) => d.mac === B)?.hostname).toBeNull();
    });

    it("marks devices missing from a later snapshot offline, keeping last_seen_at and the row", async () => {
      await post([{ mac: A, ip: "192.168.50.20" }, { mac: B, ip: "192.168.50.21" }]);
      // Backdate so the preserved last_seen is distinguishable from "now".
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
      testDb.db.update(networkDevices).set({ lastSeenAt: twoDaysAgo }).where(eq(networkDevices.mac, B)).run();

      const res = await post([{ mac: A, ip: "192.168.50.20" }]);
      expect(res.json()).toMatchObject({ online: 1, newDevices: 0, markedOffline: 1 });

      const body = await list();
      expect(body.totalCount).toBe(2);
      expect(body.onlineCount).toBe(1);
      const b = body.items.find((d) => d.mac === B);
      expect(b?.online).toBe(false);
      expect(b?.lastSeenAt).toBe(twoDaysAgo);
      // Online sorts before offline.
      expect(body.items.map((d) => d.mac)).toEqual([A, B]);
    });

    it("brings an offline device back online and refreshes last_seen_at, keeping first_seen_at", async () => {
      await post([{ mac: A }]);
      await post([{ mac: B }]);
      const before = (await list()).items.find((d) => d.mac === A);
      expect(before?.online).toBe(false);
      testDb.db.update(networkDevices).set({ firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z" }).run();

      await post([{ mac: A }, { mac: B }]);
      const after = (await list()).items.find((d) => d.mac === A);
      expect(after?.online).toBe(true);
      expect(after?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
      expect((after?.lastSeenAt ?? "") > "2026-01-02T00:00:00.000Z").toBe(true);
    });

    it("keeps a known hostname/vendor when a later snapshot omits them", async () => {
      await post([{ mac: A, hostname: "laptop", vendor: "ExampleCorp" }]);
      await post([{ mac: A, hostname: null, vendor: "" }]);
      expect((await list()).items[0]).toMatchObject({ hostname: "laptop", vendor: "ExampleCorp" });
    });

    it("an empty snapshot marks everything offline", async () => {
      await post([{ mac: A }, { mac: B }]);
      await post([]);
      const body = await list();
      expect(body.onlineCount).toBe(0);
      expect(body.totalCount).toBe(2);
    });

    it("de-duplicates repeated MACs within one snapshot", async () => {
      const res = await post([{ mac: A, ip: "192.168.50.20" }, { mac: A.toLowerCase(), ip: "192.168.50.99" }]);
      expect(res.json()).toMatchObject({ online: 1, newDevices: 1 });
      expect((await list()).items[0]?.ip).toBe("192.168.50.99");
    });
  });

  describe("alias", () => {
    it("sets, trims, and clears an alias; display name prefers alias", async () => {
      await post([{ mac: A, hostname: "android-9f8e" }]);

      const set = await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${A}`, payload: { alias: "  Rina phone " } });
      expect(set.statusCode).toBe(200);
      expect(set.json<DeviceView>()).toMatchObject({ alias: "Rina phone", name: "Rina phone", hostname: "android-9f8e" });

      const cleared = await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${A}`, payload: { alias: "" } });
      expect(cleared.json<DeviceView>()).toMatchObject({ alias: null, name: "android-9f8e" });
    });

    it("accepts a lowercase / dash-separated MAC in the URL", async () => {
      await post([{ mac: A }]);
      const res = await app.inject({ method: "PATCH", url: "/api/v1/network/devices/02-00-00-00-00-01", payload: { alias: "x" } });
      expect(res.statusCode).toBe(200);
    });

    it("is not overwritten by later snapshots, even when the router hostname changes or the device goes offline", async () => {
      await post([{ mac: A, hostname: "old-name" }]);
      await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${A}`, payload: { alias: "Kitchen tablet" } });

      await post([{ mac: A, hostname: "new-name" }]);
      await post([{ mac: B }]);
      const a = (await list()).items.find((d) => d.mac === A);
      expect(a).toMatchObject({ alias: "Kitchen tablet", hostname: "new-name", online: false });
    });

    it("returns 404 for an unknown device and 400 for a bad mac or body", async () => {
      expect((await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${C}`, payload: { alias: "x" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: "/api/v1/network/devices/nope", payload: { alias: "x" } })).statusCode).toBe(400);
      await post([{ mac: A }]);
      expect((await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${A}`, payload: { alias: "x".repeat(101) } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${A}`, payload: {} })).statusCode).toBe(400);
    });
  });

  describe("list", () => {
    it("is stale with no snapshot yet", async () => {
      const body = await list();
      expect(body).toMatchObject({ items: [], onlineCount: 0, lastSnapshotAt: null, stale: true });
    });

    it("goes stale when the last snapshot is old", async () => {
      await post([{ mac: A }]);
      testDb.sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'network_last_snapshot_at'").run("2020-01-01T00:00:00.000Z");
      expect((await list()).stale).toBe(true);
    });

    it("sorts online devices by numeric IP", async () => {
      await post([
        { mac: A, ip: "192.168.50.100" },
        { mac: B, ip: "192.168.50.9" },
      ]);
      expect((await list()).items.map((d) => d.mac)).toEqual([B, A]);
    });
  });

  describe("retention", () => {
    const old = new Date(Date.now() - OFFLINE_RETENTION_MS - 86_400_000).toISOString();

    it("drops old offline un-aliased devices but keeps aliased ones and online ones", async () => {
      await post([{ mac: A }, { mac: B }, { mac: C }]);
      await post([{ mac: C }]);
      await app.inject({ method: "PATCH", url: `/api/v1/network/devices/${B}`, payload: { alias: "keep me" } });
      testDb.db.update(networkDevices).set({ lastSeenAt: old }).run();

      const pruned = pruneNetworkDevices(testDb.db, new Date().toISOString());
      expect(pruned).toBe(1);
      expect((await list()).items.map((d) => d.mac).sort()).toEqual([B, C]);
    });

    it("caps the table by evicting the longest-offline un-aliased rows", async () => {
      const now = new Date().toISOString();
      const rows = Array.from({ length: MAX_UNALIASED_DEVICES + 5 }, (_, i) => ({
        mac: `AA:00:00:00:${String(Math.floor(i / 256)).padStart(2, "0")}:${(i % 256).toString(16).padStart(2, "0").toUpperCase()}`,
        online: false,
        firstSeenAt: now,
        lastSeenAt: new Date(Date.now() - (MAX_UNALIASED_DEVICES + 5 - i) * 1000).toISOString(),
      }));
      for (const row of rows) testDb.db.insert(networkDevices).values(row).run();

      expect(pruneNetworkDevices(testDb.db, now)).toBe(5);
      const remaining = testDb.db.select().from(networkDevices).all();
      expect(remaining).toHaveLength(MAX_UNALIASED_DEVICES);
      // The five oldest were evicted.
      expect(remaining.some((r) => r.mac === rows[0]?.mac)).toBe(false);
      expect(remaining.some((r) => r.mac === rows[5]?.mac)).toBe(true);
    });
  });
});
