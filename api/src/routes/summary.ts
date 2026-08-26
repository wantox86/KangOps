import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { containers, hosts } from "../db/schema.js";

// Response shape mirrors what the dashboard's health-score engine (Milestone 3) will eventually
// populate for real -- healthStatus/healthScore/reasons stay simplistic placeholders until that
// engine exists, but hostCount/containerCounts are now real, derived from collected data
// (Milestone 2), not hardcoded zeros.
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
      const reasons = hasCollectedData
        ? [`Tracking ${containerRows.length} container(s) across ${hostRows.length} host(s).`]
        : ["No collector configured yet."];

      // healthStatus/healthScore stay "unknown"/0 regardless of collected data -- a real
      // deterministic score engine with penalties/thresholds/evidence is explicitly Milestone 3;
      // computing a fake score here would be worse than an honest "unknown".
      return {
        healthStatus: "unknown" as const,
        healthScore: 0,
        reasons,
        hostCount: hostRows.length,
        containerCounts: counts,
      };
    },
  );
}
