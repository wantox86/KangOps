import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { startCollector, type Collector } from "../src/collector/loop.js";
import { createFixtureAdapter } from "../src/docker/fixtureAdapter.js";
import { alerts, backupTargets, containers, healthConditions } from "../src/db/schema.js";
import { saveWebhookConfig } from "../src/alerts/webhookConfigRepo.js";
import { createBackupTarget } from "../src/backups/targetsRepo.js";

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} } as unknown as import("fastify").FastifyBaseLogger;

// Integration coverage for the two new things wired into the collector's health cycle in
// Milestone 4: webhook alert dispatch (alerts/notifier.ts, called from health/cycle.ts) and
// backup freshness conditions (backups/freshness.ts, merged into the same
// reconcile/persist/score pipeline). Mirrors healthCycle.test.ts's approach of exercising this
// through the real collector loop, not by calling runHealthCycle in isolation.
describe("Milestone 4: alert dispatch + backup freshness wired into the health cycle", () => {
  let testDb: TestDb;
  let collector: Collector | undefined;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    collector?.stop();
    testDb.close();
    vi.unstubAllGlobals();
  });

  it("sends a webhook and records a sent alert when a new critical condition opens", async () => {
    saveWebhookConfig(testDb.db, { enabled: true, url: "https://example.invalid/hook", format: "generic", cooldownMinutes: 30 }, "2026-01-01T00:00:00.000Z");

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    collector = startCollector({ db: testDb.db, adapter: createFixtureAdapter(), hostId: "local", hostName: "test-host", intervalMs: 60_000, timeoutMs: 1000, retries: 0, logger: silentLogger });

    await collector.runOnce();
    testDb.db.update(containers).set({ critical: true }).where(eq(containers.dockerId, "c3d4e5f6a1b2")).run();
    await collector.runOnce();

    // Real host CPU/memory sampling (host/metrics.ts) can occasionally cross the default
    // thresholds in a CI sandbox and open/close its own host_cpu_high/host_memory_high
    // conditions independently of this test's container change -- that's legitimate behavior,
    // not something to suppress, so assert on the specific condition this test cares about
    // rather than a total call count.
    expect(fetchMock).toHaveBeenCalled();
    const calledUrls = fetchMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(calledUrls.every((url) => url === "https://example.invalid/hook")).toBe(true);

    const sentAlerts = testDb.db.select().from(alerts).where(eq(alerts.status, "sent")).all();
    const containerAlerts = sentAlerts.filter((a) => a.code === "critical_container_down");
    expect(containerAlerts).toHaveLength(1);
  });

  it("does not re-send within the cooldown window for the same still-open condition", async () => {
    saveWebhookConfig(testDb.db, { enabled: true, url: "https://example.invalid/hook", format: "generic", cooldownMinutes: 30 }, "2026-01-01T00:00:00.000Z");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    collector = startCollector({ db: testDb.db, adapter: createFixtureAdapter(), hostId: "local", hostName: "test-host", intervalMs: 60_000, timeoutMs: 1000, retries: 0, logger: silentLogger });

    await collector.runOnce();
    testDb.db.update(containers).set({ critical: true }).where(eq(containers.dockerId, "c3d4e5f6a1b2")).run();
    await collector.runOnce(); // opens the condition, sends 1 alert
    await collector.runOnce(); // still open, same cycle-over-cycle -- reconcile.ts won't even treat this as "new"

    const containerAlerts = testDb.db.select().from(alerts).where(eq(alerts.code, "critical_container_down")).all();
    expect(containerAlerts).toHaveLength(1);
  });

  it("never throws out of the collector cycle when the webhook delivery fails", async () => {
    saveWebhookConfig(testDb.db, { enabled: true, url: "https://example.invalid/hook", format: "generic", cooldownMinutes: 30 }, "2026-01-01T00:00:00.000Z");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );

    collector = startCollector({ db: testDb.db, adapter: createFixtureAdapter(), hostId: "local", hostName: "test-host", intervalMs: 60_000, timeoutMs: 1000, retries: 0, logger: silentLogger });

    await collector.runOnce();
    testDb.db.update(containers).set({ critical: true }).where(eq(containers.dockerId, "c3d4e5f6a1b2")).run();
    await expect(collector.runOnce()).resolves.not.toThrow();

    const failedAlerts = testDb.db.select().from(alerts).where(eq(alerts.status, "failed")).all();
    expect(failedAlerts.length).toBeGreaterThan(0);
    expect(failedAlerts[0]?.error).toContain("network unreachable");
  });

  it("raises a backup_stale health condition once a target's expected frequency has elapsed", async () => {
    // createBackupTarget stamps createdAt = nowIso, and evaluateBackupHealth's "never reported"
    // branch only fires once (now - createdAt) exceeds expectedFrequencyMinutes -- so backdate
    // createdAt directly rather than waiting in the test.
    createBackupTarget(testDb.db, { name: "nightly-db", expectedFrequencyMinutes: 5, checkPath: null }, "2020-01-01T00:00:00.000Z");

    collector = startCollector({ db: testDb.db, adapter: createFixtureAdapter(), hostId: "local", hostName: "test-host", intervalMs: 60_000, timeoutMs: 1000, retries: 0, logger: silentLogger });
    await collector.runOnce();

    const active = testDb.db.select().from(healthConditions).where(eq(healthConditions.active, true)).all();
    expect(active.some((c) => c.code === "backup_missing" && c.entityType === "backup_target")).toBe(true);
  });

  it("does not flag a freshly-created backup target before its first window elapses", async () => {
    createBackupTarget(testDb.db, { name: "nightly-db", expectedFrequencyMinutes: 60, checkPath: null }, new Date().toISOString());

    collector = startCollector({ db: testDb.db, adapter: createFixtureAdapter(), hostId: "local", hostName: "test-host", intervalMs: 60_000, timeoutMs: 1000, retries: 0, logger: silentLogger });
    await collector.runOnce();

    const active = testDb.db.select().from(healthConditions).where(eq(healthConditions.entityType, "backup_target")).all();
    expect(active).toHaveLength(0);
  });

  it("does not error the cycle when a backup target row exists but is otherwise unremarkable", async () => {
    testDb.db.insert(backupTargets).values({ name: "x", expectedFrequencyMinutes: 60, checkPath: null, token: "t", enabled: true, createdAt: new Date().toISOString() }).run();
    collector = startCollector({ db: testDb.db, adapter: createFixtureAdapter(), hostId: "local", hostName: "test-host", intervalMs: 60_000, timeoutMs: 1000, retries: 0, logger: silentLogger });
    await expect(collector.runOnce()).resolves.not.toThrow();
  });
});
