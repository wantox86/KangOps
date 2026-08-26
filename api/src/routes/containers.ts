import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { containers, events } from "../db/schema.js";

const containerSchema = {
  type: "object",
  required: [
    "dockerId",
    "name",
    "image",
    "imageDigest",
    "state",
    "health",
    "composeProject",
    "composeService",
    "restartCount",
    "critical",
    "firstSeenAt",
    "lastSeenAt",
  ],
  properties: {
    dockerId: { type: "string" },
    name: { type: "string" },
    image: { type: "string" },
    imageDigest: { type: ["string", "null"] },
    state: { type: "string" },
    health: { type: "string" },
    composeProject: { type: ["string", "null"] },
    composeService: { type: ["string", "null"] },
    restartCount: { type: "integer" },
    critical: { type: "boolean" },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["containers"],
  properties: { containers: { type: "array", items: containerSchema } },
} as const;

const eventSchema = {
  type: "object",
  required: ["id", "occurredAt", "source", "type", "severity", "summary"],
  properties: {
    id: { type: "integer" },
    occurredAt: { type: "string" },
    source: { type: "string" },
    type: { type: "string" },
    severity: { type: "string" },
    summary: { type: "string" },
  },
} as const;

const detailResponseSchema = {
  type: "object",
  required: ["container", "events"],
  properties: {
    container: containerSchema,
    events: { type: "array", items: eventSchema },
  },
} as const;

function toApiShape(row: typeof containers.$inferSelect) {
  return {
    dockerId: row.dockerId,
    name: row.currentName,
    image: row.imageRef,
    imageDigest: row.imageDigest,
    state: row.currentState,
    health: row.currentHealth,
    composeProject: row.composeProject,
    composeService: row.composeService,
    restartCount: row.restartCount,
    critical: row.critical,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

// Read-only surface over the collector's persisted data -- the web UI never talks to Docker
// directly (per CLAUDE.md's API boundary: "Do not expose raw Docker inspect payloads as a
// permanent public contract"). Every field here is our normalized shape, not a raw passthrough.
export function registerContainerRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/containers", { schema: { response: { 200: listResponseSchema } } }, async () => {
    const rows = db.select().from(containers).all();
    return { containers: rows.map(toApiShape) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/containers/:id",
    { schema: { response: { 200: detailResponseSchema } } },
    async (request, reply) => {
      const row = db.select().from(containers).where(eq(containers.dockerId, request.params.id)).all()[0];
      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "No container with that id" });
      }

      // Most-recent-first, bounded -- per UX spec's "recent" events, not the full unbounded
      // history; matches the "never create an unbounded raw time-series table" caution for the
      // events list surfaced in one response.
      const recentEvents = db
        .select()
        .from(events)
        .where(eq(events.containerId, row.dockerId))
        .orderBy(desc(events.occurredAt))
        .limit(50)
        .all();

      return {
        container: toApiShape(row),
        events: recentEvents.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt,
          source: e.source,
          type: e.type,
          severity: e.severity,
          summary: e.summary,
        })),
      };
    },
  );
}
