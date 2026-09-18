import type { FastifyInstance } from "fastify";
import { buildPortalGroups } from "../portal/catalog.js";

const portalEntrySchema = {
  type: "object",
  required: ["name", "description", "host", "runtime", "exposure", "status"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    host: { type: "string" },
    runtime: { type: "string" },
    exposure: { type: "string" },
    status: { type: "string" },
    url: { type: "string" },
    lanUrl: { type: "string" },
  },
} as const;

const portalResponseSchema = {
  type: "object",
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "entries"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          entries: { type: "array", items: portalEntrySchema },
        },
      },
    },
  },
} as const;

// Static catalog (api/src/portal/catalog.ts) served as JSON. Deliberately not in the DB:
// it changes with the homelab, not at runtime, and keeping it in git makes every edit
// reviewable next to the code. Dead tunnel entries are kept listed with status "dead"
// rather than deleted -- the portal documents what the homelab *has*, not just what answers.
export function registerPortalRoutes(app: FastifyInstance): void {
  app.get("/api/v1/portal", { schema: { response: { 200: portalResponseSchema } } }, async () => {
    return { groups: buildPortalGroups() };
  });
}
