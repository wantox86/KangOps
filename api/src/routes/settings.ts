import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { getThresholds, saveThresholds, thresholdsSchema } from "../health/thresholdsRepo.js";

const thresholdsResponseSchema = {
  type: "object",
  required: [
    "cpuWarningPercent",
    "cpuCriticalPercent",
    "memoryWarningPercent",
    "memoryCriticalPercent",
    "diskWarningPercent",
    "diskCriticalPercent",
    "restartLoopCount",
    "restartLoopWindowMinutes",
    "healthyMinScore",
    "attentionMinScore",
  ],
  properties: {
    cpuWarningPercent: { type: "number" },
    cpuCriticalPercent: { type: "number" },
    memoryWarningPercent: { type: "number" },
    memoryCriticalPercent: { type: "number" },
    diskWarningPercent: { type: "number" },
    diskCriticalPercent: { type: "number" },
    restartLoopCount: { type: "integer" },
    restartLoopWindowMinutes: { type: "integer" },
    healthyMinScore: { type: "number" },
    attentionMinScore: { type: "number" },
  },
} as const;

// Non-secret settings only (per CLAUDE.md's data model note on `settings`) -- health/scoring
// thresholds and critical-container flags (the latter via PATCH /api/v1/containers/:id) are the
// only user configuration Milestone 3 needs. No auth here yet -- API-wide auth is an explicit
// MVP exclusion per the spec ("reverse proxy auth or local trusted network").
export function registerSettingsRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/settings", { schema: { response: { 200: thresholdsResponseSchema } } }, async () => {
    return getThresholds(db);
  });

  app.put("/api/v1/settings", { schema: { response: { 200: thresholdsResponseSchema } } }, async (request, reply) => {
    const parsed = thresholdsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_settings", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    saveThresholds(db, parsed.data, new Date().toISOString());
    return parsed.data;
  });
}
