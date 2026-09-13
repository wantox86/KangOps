import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { containers as containersTable, metricSamples } from "../db/schema.js";
import { evaluateHealth } from "../health/engine.js";
import type { HealthConditionInput, HealthThresholds } from "../health/types.js";
import { listAgents } from "./repo.js";
import { STALE_INTERVAL_MULTIPLIER, type AgentSnapshot } from "./types.js";

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

export function isAgentStale(snapshot: AgentSnapshot, nowIso: string): boolean {
  if (!snapshot.lastReportAt) return false;
  const ageMs = new Date(nowIso).getTime() - new Date(snapshot.lastReportAt).getTime();
  return ageMs > snapshot.expectedIntervalSeconds * STALE_INTERVAL_MULTIPLIER * 1000;
}

// Pure: same contract as health/engine.ts's evaluateHealth and backups/freshness.ts's
// evaluateBackupHealth -- no DB, no clock read beyond the passed-in nowIso. health/cycle.ts
// merges the result into the same single reconcile/persist/score pass as local host, container,
// and backup conditions, so a remote host's disk filling up scores identically to the local
// host's doing so.
export function evaluateAgentHealth(snapshots: AgentSnapshot[], thresholds: HealthThresholds, nowIso: string): HealthConditionInput[] {
  const conditions: HealthConditionInput[] = [];

  for (const snapshot of snapshots) {
    if (!snapshot.enabled) continue;

    // Registered but never reported yet (agent not deployed, or deployed and broken from the
    // start) produces no condition at all: it's a setup state, not a regression, and an
    // attention-queue row for a host that has never been up is noise. It stays visible as a
    // status:"unknown" row in GET /hosts, which is where a half-finished setup belongs.
    if (!snapshot.lastReportAt) continue;

    if (isAgentStale(snapshot, nowIso)) {
      conditions.push({
        entityType: "host",
        entityId: snapshot.hostId,
        code: "agent_unreachable",
        severity: "critical",
        // Matches collector_unavailable's penalty -- CLAUDE.md's health table prices
        // "collector/node unavailable" at 20 regardless of which mechanism went quiet.
        penalty: 20,
        summary: `Agent "${snapshot.name}" has not reported since ${snapshot.lastReportAt}`,
        evidence: {
          lastReportAt: snapshot.lastReportAt,
          expectedIntervalSeconds: snapshot.expectedIntervalSeconds,
          staleAfterSeconds: snapshot.expectedIntervalSeconds * STALE_INTERVAL_MULTIPLIER,
        },
      });
      // Deliberately no metric/container conditions for a stale agent: its last reported numbers
      // describe a host we can no longer observe. Scoring them would keep a dead host's stale
      // "all fine" (or stale "CPU high") reading alive in the attention queue indefinitely.
      continue;
    }

    const result = evaluateHealth(
      {
        hosts: [
          {
            hostId: snapshot.hostId,
            // "reachable" by construction -- staleness above is this host's liveness signal, and
            // passing anything else here would double-count it as collector_unavailable too.
            status: "reachable",
            cpuPercent: snapshot.cpuPercent,
            memoryPercent: snapshot.memoryPercent,
            diskPercent: snapshot.diskPercent,
          },
        ],
        containers: snapshot.containers,
      },
      thresholds,
    );
    conditions.push(...result.conditions);
  }

  return conditions;
}

// Impure gathering step: builds the snapshots the pure evaluator above consumes, from whatever
// the agents have already pushed into the normal metric_samples/containers tables.
export function gatherAgentSnapshots(db: DbClient): AgentSnapshot[] {
  return listAgents(db).map((agent) => {
    const latest = db
      .select()
      .from(metricSamples)
      .where(and(eq(metricSamples.hostId, agent.hostId), isNull(metricSamples.containerId)))
      .orderBy(desc(metricSamples.observedAt))
      .limit(1)
      .all()[0];

    const rows = db.select().from(containersTable).where(eq(containersTable.hostId, agent.hostId)).all();

    return {
      hostId: agent.hostId,
      name: agent.name,
      enabled: agent.enabled,
      expectedIntervalSeconds: agent.expectedIntervalSeconds,
      lastReportAt: agent.lastReportAt,
      cpuPercent: latest?.cpuPercent ?? null,
      memoryPercent: percent(latest?.memoryBytes ?? null, latest?.memoryLimitBytes ?? null),
      diskPercent: percent(latest?.diskUsedBytes ?? null, latest?.diskTotalBytes ?? null),
      containers: rows
        .filter((row) => row.currentState !== "removed")
        .map((row) => ({
          dockerId: row.dockerId,
          name: row.currentName,
          state: row.currentState,
          health: row.currentHealth,
          critical: row.critical,
          // Always 0 for agent hosts -- see ingest.ts's toNormalized comment on why the agent
          // doesn't collect RestartCount.
          restartsInWindow: 0,
          // The agent reports container facts, not per-container cpu/memory stats: that needs a
          // stats call per container per tick, which is the single most expensive thing it could
          // do on a low-power host. Host-level CPU/memory above covers "is this box struggling".
          cpuPercent: null,
          memoryPercent: null,
        })),
    };
  });
}
