import type { FastifyInstance } from "fastify";

// Response shape mirrors what the dashboard's health-score engine (Milestone 3) will
// eventually populate for real -- fixed now so the web shell (also Milestone 1) has a stable
// contract to build against, even though every value is a placeholder default until the
// collector (Milestone 2) and health engine (Milestone 3) exist.
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

export function registerSummaryRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/summary",
    { schema: { response: { 200: summaryResponseSchema } } },
    async () => {
      // Milestone 1 placeholder: no collector exists yet, so there is nothing real to report.
      // "unknown" (not "healthy") is deliberate -- claiming a healthy homelab with zero
      // evidence would be misleading once this endpoint is wired into the dashboard.
      return {
        healthStatus: "unknown" as const,
        healthScore: 0,
        reasons: ["No collector configured yet (Milestone 2)."],
        hostCount: 0,
        containerCounts: {
          running: 0,
          unhealthy: 0,
          restarting: 0,
          stopped: 0,
          unknown: 0,
        },
      };
    },
  );
}
