import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { containers, healthConditions, hosts } from "../db/schema.js";
import { summarizeConditions } from "../health/engine.js";
import { getThresholds } from "../health/thresholdsRepo.js";

// healthStatus/healthScore/reasons are now real (Milestone 3's health engine, via persisted
// health_conditions rows -- see health/cycle.ts and health/engine.ts's summarizeConditions),
// not the "unknown"/0 placeholders from Milestone 2.
const summaryResponseSchema = {
  type: "object",
  required: ["healthStatus", "healthScore", "reasons", "hostCount", "containerCounts"],
  properties: {
    healthStatus: { type: "string", enum: ["healthy", "attention", "critical", "unknown"] },
    healthScore: { type: "number", minimum: 0, maximum: 100 },
    reasons: { type: "array", items: { type: "string" } },
    hostCount: { type: "integer", minimum: 0 },
    containerCounts: {
      type: "object",
      required: ["running", "unhealthy", "restarting", "stopped", "unknown"],
      properties: {
        running: { type: "integer", minimum: 0 },
        unhealthy: { type: "integer", minimum: 0 },
        restarting: { type: "integer", minimum: 0 },
        stopped: { type: "integer", minimum: 0 },
        unknown: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

export function registerSummaryRoutes(app: FastifyInstance, db: DbClient): void {
  app.get(
    "/api/v1/summary",
    { schema: { response: { 200: summaryResponseSchema } } },
    async () => {
      const hostRows = db.select().from(hosts).all();
      const containerRows = db.select().from(containers).all();

      const counts = { running: 0, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 };
      for (const row of containerRows) {
        if (row.currentState === "removed") continue;
        if (row.currentHealth === "unhealthy") counts.unhealthy++;
        else if (row.currentState === "running") counts.running++;
        else if (row.currentState === "restarting") counts.restarting++;
        else if (row.currentState === "exited" || row.currentState === "dead") counts.stopped++;
        else counts.unknown++;
      }

      const hasCollectedData = hostRows.length > 0;

      if (!hasCollectedData) {
        return {
          healthStatus: "unknown" as const,
          healthScore: 0,
          reasons: ["No collector configured yet."],
          hostCount: 0,
          containerCounts: counts,
        };
      }

      const thresholds = getThresholds(db);
      const active = db.select().from(healthConditions).where(eq(healthConditions.active, true)).all();
      const { score, status } = summarizeConditions(active, thresholds);

      const topReasons = [...active]
        .sort((a, b) => b.penalty - a.penalty)
        .slice(0, 3)
        .map((c) => c.summary);
      const reasons =
        topReasons.length > 0 ? topReasons : [`Tracking ${containerRows.length} container(s) across ${hostRows.length} host(s). No active issues.`];

      return {
        healthStatus: status,
        healthScore: score,
        reasons,
        hostCount: hostRows.length,
        containerCounts: counts,
      };
    },
  );
}
