import { and, eq, gte } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { evaluateAgentHealth, gatherAgentSnapshots } from "../agents/health.js";
import { dispatchAlerts } from "../alerts/notifier.js";
import { gatherBackupStatuses } from "../backups/gather.js";
import { evaluateBackupHealth } from "../backups/freshness.js";
import type { DbClient } from "../db/client.js";
import { containers as containersTable, events, healthConditions, hosts, metricSamples } from "../db/schema.js";
import type { DockerReadAdapter } from "../docker/types.js";
import { collectHostMetrics } from "../host/metrics.js";
import { evaluateHealth, summarizeConditions } from "./engine.js";
import { reconcileConditions } from "./reconcile.js";
import { getThresholds } from "./thresholdsRepo.js";
import type { ContainerHealthInput, HealthConditionInput, HealthResult, HostHealthInput } from "./types.js";

export interface HealthCycleOptions {
  db: DbClient;
  adapter: DockerReadAdapter;
  hostId: string;
  hostStatus: string;
  nowIso: string;
  diskPath?: string | undefined;
  logger?: FastifyBaseLogger | undefined;
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
  const { db, adapter, hostId, hostStatus, nowIso, diskPath, logger } = options;
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

  const hostResult = evaluateHealth({ hosts: [hostInput], containers: containerInputs }, thresholds);

  // Backup freshness conditions are computed by a separate pure evaluator (backups/freshness.ts)
  // and merged in here rather than folded into evaluateHealth itself -- health/engine.ts stays
  // Milestone 3's host/container-only domain, and this module is the one place that already
  // knows how to gather+reconcile+score conditions from multiple sources. Failure to gather
  // backup status (e.g. an unreadable checkPath) is caught inside gatherBackupStatuses itself,
  // never here -- must not break the host/container health cycle above.
  let backupConditions: HealthConditionInput[] = [];
  try {
    const backupStatuses = await gatherBackupStatuses(db, logger);
    backupConditions = evaluateBackupHealth(backupStatuses, nowIso);
  } catch (err) {
    logger?.error({ err }, "backup freshness gathering failed");
  }

  // Agent-reported remote hosts (Milestone 7) are folded in the same way backup conditions are:
  // a separate gather + pure evaluator, merged into the one reconcile/persist/score pass below.
  // This is what makes a remote host's disk/CPU/container problems land in the same attention
  // queue and the same health score as the local host's, with no parallel scoring path. The
  // local collector cycle is the only clock in the process, so it's also what detects an agent
  // having gone silent -- an agent that stops reporting can't report its own absence.
  let agentConditions: HealthConditionInput[] = [];
  try {
    agentConditions = evaluateAgentHealth(gatherAgentSnapshots(db), thresholds, nowIso);
  } catch (err) {
    logger?.error({ err }, "agent health evaluation failed");
  }

  const allConditions = [...hostResult.conditions, ...backupConditions, ...agentConditions];

  const existingActive = db.select().from(healthConditions).where(eq(healthConditions.active, true)).all();
  const { toInsert, toResolveIds } = reconcileConditions(allConditions, existingActive, nowIso);

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

  // Webhook alerts fire only for conditions newly opened *this cycle* (toInsert) -- an already-
  // active condition never re-alerts just because it's still active, and notifier.ts's own
  // cooldown additionally guards a flapping condition from re-alerting on every resolve/reopen.
  // Never allowed to throw out of runHealthCycle -- a webhook failure must not fail the
  // collector cycle that triggered it (see collector/loop.ts's own try/catch around this call).
  try {
    await dispatchAlerts(db, toInsert, hostId, nowIso, logger);
  } catch (err) {
    logger?.error({ err }, "alert dispatch failed");
  }

  const { score, status } = summarizeConditions(allConditions, thresholds);
  return { score, status, conditions: allConditions };
}
