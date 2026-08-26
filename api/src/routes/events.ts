import { desc, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { events } from "../db/schema.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const eventSchema = {
  type: "object",
  required: ["id", "occurredAt", "source", "type", "severity", "summary", "containerId"],
  properties: {
    id: { type: "integer" },
    occurredAt: { type: "string" },
    containerId: { type: ["string", "null"] },
    source: { type: "string" },
    type: { type: "string" },
    severity: { type: "string" },
    summary: { type: "string" },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["events"],
  properties: { events: { type: "array", items: eventSchema } },
} as const;

// Global event timeline (per the API boundary spec's `GET /events`) -- distinct from
// GET /api/v1/containers/:id/events (embedded in the detail response), this one spans all
// containers/host-level events for the compact recent-events timeline on the dashboard.
// Cursor-paginated by occurredAt (`before` query param) instead of offset, since this table can
// grow large over time and offset pagination degrades as it does.
export function registerEventRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    "/api/v1/events",
    { schema: { response: { 200: listResponseSchema } } },
    async (request) => {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.query.limit) || DEFAULT_LIMIT));
      const before = request.query.before;

      const rows = db
        .select()
        .from(events)
        .where(before ? lt(events.occurredAt, before) : undefined)
        .orderBy(desc(events.occurredAt))
        .limit(limit)
        .all();

      return {
        events: rows.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt,
          containerId: e.containerId,
          source: e.source,
          type: e.type,
          severity: e.severity,
          summary: e.summary,
        })),
      };
    },
  );
}
