import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { hosts } from "../db/schema.js";

const hostSchema = {
  type: "object",
  required: ["id", "name", "status", "firstSeenAt", "lastSeenAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["hosts"],
  properties: { hosts: { type: "array", items: hostSchema } },
} as const;

// Read-only list of collector-tracked hosts (per the API boundary spec's `GET /hosts`) --
// single-node today, but the shape doesn't change once Milestone 4 adds more.
export function registerHostRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/hosts", { schema: { response: { 200: listResponseSchema } } }, async () => {
    const rows = db.select().from(hosts).all();
    return {
      hosts: rows.map((h) => ({
        id: h.id,
        name: h.name,
        status: h.status,
        firstSeenAt: h.firstSeenAt,
        lastSeenAt: h.lastSeenAt,
      })),
    };
  });
}
