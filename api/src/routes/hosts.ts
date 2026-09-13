import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { listAgents } from "../agents/repo.js";
import type { DbClient } from "../db/client.js";
import { containers, hosts, metricSamples } from "../db/schema.js";

const hostSchema = {
  type: "object",
  required: ["id", "name", "status", "kind", "firstSeenAt", "lastSeenAt", "cpuPercent", "memoryPercent", "diskPercent", "containerCount", "agentVersion"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    // "local" = polled by this process's own collector; "agent" = pushes its own reports in
    // (Milestone 7). The dashboard labels them differently because the failure modes differ:
    // a local host can't be "stale", and an agent host can't be diagnosed from here.
    kind: { type: "string", enum: ["local", "agent"] },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
    cpuPercent: { type: ["number", "null"] },
    memoryPercent: { type: ["number", "null"] },
    diskPercent: { type: ["number", "null"] },
    containerCount: { type: "integer" },
    agentVersion: { type: ["string", "null"] },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["hosts"],
  properties: { hosts: { type: "array", items: hostSchema } },
} as const;

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

// Read-only list of every tracked host -- the local collector's own host plus every agent-
// reporting remote host, in one uniform shape. Milestone 7 widened this from bare identity
// fields to include each host's latest capacity reading and container count, so the dashboard
// can render a multi-host overview from this single call instead of fanning out per host.
export function registerHostRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/hosts", { schema: { response: { 200: listResponseSchema } } }, async () => {
    const rows = db.select().from(hosts).all();
    const agentsByHostId = new Map(listAgents(db).map((a) => [a.hostId, a]));
    const containerRows = db.select().from(containers).all();

    return {
      hosts: rows.map((h) => {
        const latest = db
          .select()
          .from(metricSamples)
          .where(and(eq(metricSamples.hostId, h.id), isNull(metricSamples.containerId)))
          .orderBy(desc(metricSamples.observedAt))
          .limit(1)
          .all()[0];
        const agent = agentsByHostId.get(h.id);

        return {
          id: h.id,
          name: h.name,
          status: h.status,
          kind: agent ? ("agent" as const) : ("local" as const),
          firstSeenAt: h.firstSeenAt,
          lastSeenAt: h.lastSeenAt,
          cpuPercent: latest?.cpuPercent ?? null,
          memoryPercent: percent(latest?.memoryBytes ?? null, latest?.memoryLimitBytes ?? null),
          diskPercent: percent(latest?.diskUsedBytes ?? null, latest?.diskTotalBytes ?? null),
          containerCount: containerRows.filter((c) => c.hostId === h.id && c.currentState !== "removed").length,
          agentVersion: agent?.agentVersion ?? null,
        };
      }),
    };
  });
}
