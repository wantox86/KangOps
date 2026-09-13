import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { containers, events, hosts, metricSamples, type Agent } from "../db/schema.js";
import { diffContainer, diffMissing } from "../collector/diff.js";
import type { NormalizedContainer } from "../docker/types.js";
import { recordAgentReport } from "./repo.js";
import type { AgentReport, ReportedContainer } from "./payload.js";

export interface IngestResult {
  containersSynced: number;
  cameOnline: boolean;
}

// The agent reports Docker's /containers/json shape only -- one cheap API call per cycle. That
// endpoint does NOT carry RestartCount (only /containers/{id}/json does), and issuing an inspect
// per container every tick is exactly the kind of avoidable work the low-power target host can't
// afford, so restartCount is reported as 0 for agent hosts. Consequence, stated plainly rather
// than hidden: the restart_loop health condition cannot fire for agent-monitored containers.
// state/health transitions, which is what the attention queue actually leans on, work normally.
function toNormalized(reported: ReportedContainer): NormalizedContainer {
  return {
    dockerId: reported.dockerId,
    name: reported.name,
    image: reported.image,
    imageDigest: reported.imageDigest ?? null,
    state: reported.state,
    health: reported.health,
    composeProject: reported.composeProject ?? null,
    composeService: reported.composeService ?? null,
    startedAt: null,
    restartCount: 0,
  };
}

// Impure counterpart to agents/health.ts's pure evaluator: applies one validated agent report to
// the database. Deliberately reuses collector/diff.ts rather than reimplementing container
// diffing -- an agent-reported container and a locally-polled one produce identical rows and
// identical lifecycle events, so the dashboard, event timeline, and health engine can't tell
// (or care) which host a container came from.
export function ingestAgentReport(db: DbClient, agent: Agent, report: AgentReport, nowIso: string): IngestResult {
  const hostId = agent.hostId;

  const existingHost = db.select().from(hosts).where(eq(hosts.id, hostId)).all()[0];
  const cameOnline = existingHost?.status !== "reachable";

  db.update(hosts)
    .set({
      status: "reachable",
      lastSeenAt: nowIso,
      // Host-reported facts (kernel, uptime, agent version) belong in the free-form metadata
      // column, not in new typed columns -- they're informational only and vary by agent.
      metadataJson: JSON.stringify({
        kind: "agent",
        hostname: report.hostname ?? null,
        kernel: report.kernel ?? null,
        uptimeSeconds: report.uptimeSeconds ?? null,
        agentVersion: report.agentVersion,
      }),
    })
    .where(eq(hosts.id, hostId))
    .run();

  db.insert(metricSamples)
    .values({
      hostId,
      containerId: null,
      observedAt: nowIso,
      cpuPercent: report.host.cpuPercent ?? null,
      memoryBytes: report.host.memoryUsedBytes ?? null,
      memoryLimitBytes: report.host.memoryTotalBytes ?? null,
      diskUsedBytes: report.host.diskUsedBytes ?? null,
      diskTotalBytes: report.host.diskTotalBytes ?? null,
    })
    .run();

  let containersSynced = 0;
  // Undefined means "this agent has no Docker visibility at all" -- leave any previously known
  // containers untouched rather than marking them removed, which would fabricate a removal event
  // for containers that are probably still running (the agent just stopped being able to see
  // them). An empty array is a real observation of zero containers and does mark them removed.
  if (report.containers) {
    const existingRows = db.select().from(containers).where(eq(containers.hostId, hostId)).all();
    const existingById = new Map(existingRows.map((row) => [row.dockerId, row]));
    const reportedIds = new Set(report.containers.map((c) => c.dockerId));

    for (const reported of report.containers) {
      const { upsert, events: newEvents } = diffContainer(toNormalized(reported), existingById.get(reported.dockerId), nowIso);
      upsert.hostId = hostId;
      db.insert(containers).values(upsert).onConflictDoUpdate({ target: containers.dockerId, set: upsert }).run();
      for (const event of newEvents) {
        db.insert(events).values({ ...event, hostId, source: "agent" }).run();
      }
      containersSynced++;
    }

    for (const row of existingRows) {
      if (!reportedIds.has(row.dockerId) && row.currentState !== "removed") {
        const { upsert, events: newEvents } = diffMissing(row, nowIso);
        db.insert(containers).values(upsert).onConflictDoUpdate({ target: containers.dockerId, set: upsert }).run();
        for (const event of newEvents) {
          db.insert(events).values({ ...event, hostId, source: "agent" }).run();
        }
      }
    }
  }

  // One event per online transition, not one per report -- the events table is a timeline a human
  // reads, and a 30s heartbeat would drown it (same reasoning as backups/gather.ts not writing a
  // run row every cycle).
  if (cameOnline) {
    db.insert(events)
      .values({
        hostId,
        containerId: null,
        occurredAt: nowIso,
        source: "agent",
        type: "agent_online",
        severity: "info",
        summary: `Agent "${agent.name}" reported in (version ${report.agentVersion})`,
        metadataJson: null,
      })
      .run();
  }

  recordAgentReport(db, agent.id, report.agentVersion, nowIso);

  return { containersSynced, cameOnline };
}
