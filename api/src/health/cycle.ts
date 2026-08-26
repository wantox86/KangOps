import { and, eq, gte } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { containers as containersTable, events, healthConditions, hosts, metricSamples } from "../db/schema.js";
import type { DockerReadAdapter } from "../docker/types.js";
import { collectHostMetrics } from "../host/metrics.js";
import { evaluateHealth } from "./engine.js";
import { reconcileConditions } from "./reconcile.js";
import { getThresholds } from "./thresholdsRepo.js";
import type { ContainerHealthInput, HealthResult, HostHealthInput } from "./types.js";

export interface HealthCycleOptions {
  db: DbClient;
  adapter: DockerReadAdapter;
  hostId: string;
  hostStatus: string;
  nowIso: string;
  diskPath?: string | undefined;
}

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

function restartsInWindow(db: DbClient, hostId: string, windowStartIso: string): Map<string, number> {
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.hostId, hostId), eq(events.type, "container_restarted"), gte(events.occurredAt, windowStartIso)))
    .all();
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.containerId) continue;
    counts.set(row.containerId, (counts.get(row.containerId) ?? 0) + 1);
  }
  return counts;
}

// Runs after the collector has persisted this tick's container observations. Gathers a host
// metrics snapshot + per-container stats (best-effort -- a container that just stopped won't
// have stats, and that's fine, not an error), persists them as metric_samples, evaluates the
// pure health engine against current state, and reconciles health_conditions. Kept separate
// from collector/loop.ts's diff/upsert logic so each piece stays independently testable.
export async function runHealthCycle(options: HealthCycleOptions): Promise<HealthResult> {
  const { db, adapter, hostId, hostStatus, nowIso, diskPath } = options;
  const thresholds = getThresholds(db);

  const hostMetrics = await collectHostMetrics(200, diskPath);
  db.insert(metricSamples)
    .values({
      hostId,
      containerId: null,
      observedAt: nowIso,
      cpuPercent: hostMetrics.cpuPercent,
      memoryBytes: hostMetrics.memoryUsedBytes,
      memoryLimitBytes: hostMetrics.memoryTotalBytes,
      diskUsedBytes: hostMetrics.diskUsedBytes,
      diskTotalBytes: hostMetrics.diskTotalBytes,
    })
    .run();

  const currentContainers = db.select().from(containersTable).where(eq(containersTable.hostId, hostId)).all();
  const activeContainers = currentContainers.filter((c) => c.currentState !== "removed");

  const windowStartIso = new Date(new Date(nowIso).getTime() - thresholds.restartLoopWindowMinutes * 60_000).toISOString();
  const restartCounts = restartsInWindow(db, hostId, windowStartIso);

  const containerInputs: ContainerHealthInput[] = [];
  for (const container of activeContainers) {
    let cpuPercent: number | null = null;
    let memoryPercent: number | null = null;

    if (container.currentState === "running") {
      const stats = await adapter.getStats(container.dockerId).catch(() => null);
      if (stats) {
        cpuPercent = stats.cpuPercent;
        memoryPercent = percent(stats.memoryBytes, stats.memoryLimitBytes);
        db.insert(metricSamples)
          .values({
            hostId,
            containerId: container.dockerId,
            observedAt: nowIso,
            cpuPercent: stats.cpuPercent,
            memoryBytes: stats.memoryBytes,
            memoryLimitBytes: stats.memoryLimitBytes,
            diskUsedBytes: null,
            diskTotalBytes: null,
          })
          .run();
      }
    }

    containerInputs.push({
      dockerId: container.dockerId,
      name: container.currentName,
      state: container.currentState,
      health: container.currentHealth,
      critical: container.critical,
      restartsInWindow: restartCounts.get(container.dockerId) ?? 0,
      cpuPercent,
      memoryPercent,
    });
  }

  const hostInput: HostHealthInput = {
    hostId,
    status: hostStatus,
    cpuPercent: hostMetrics.cpuPercent,
    memoryPercent: percent(hostMetrics.memoryUsedBytes, hostMetrics.memoryTotalBytes),
    diskPercent: percent(hostMetrics.diskUsedBytes, hostMetrics.diskTotalBytes),
  };

  const result = evaluateHealth({ hosts: [hostInput], containers: containerInputs }, thresholds);

  const existingActive = db.select().from(healthConditions).where(eq(healthConditions.active, true)).all();
  const { toInsert, toResolveIds } = reconcileConditions(result.conditions, existingActive, nowIso);

  if (toInsert.length > 0) {
    db.insert(healthConditions).values(toInsert).run();
  }
  for (const id of toResolveIds) {
    db.update(healthConditions).set({ active: false, resolvedAt: nowIso }).where(eq(healthConditions.id, id)).run();
  }

  // Keep the hosts row's collector-observed status separate from health-condition penalties --
  // this write is defensive (loop.ts already sets it) so runHealthCycle stays correct if ever
  // called standalone (e.g. from a test) without the surrounding collector cycle.
  db.update(hosts).set({ lastSeenAt: nowIso }).where(eq(hosts.id, hostId)).run();

  return result;
}
