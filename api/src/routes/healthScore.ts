import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { healthConditions } from "../db/schema.js";
import { summarizeConditions } from "../health/engine.js";
import { getThresholds } from "../health/thresholdsRepo.js";
import type { Severity } from "../health/types.js";

const conditionSchema = {
  type: "object",
  required: ["id", "entityType", "entityId", "code", "severity", "penalty", "summary", "detectedAt", "evidence"],
  properties: {
    id: { type: "integer" },
    entityType: { type: "string" },
    entityId: { type: "string" },
    code: { type: "string" },
    severity: { type: "string" },
    penalty: { type: "integer" },
    summary: { type: "string" },
    detectedAt: { type: "string" },
    evidence: {},
  },
} as const;

const healthResponseSchema = {
  type: "object",
  required: ["status", "score", "conditions"],
  properties: {
    status: { type: "string", enum: ["healthy", "attention", "critical"] },
    score: { type: "number", minimum: 0, maximum: 100 },
    conditions: { type: "array", items: conditionSchema },
  },
} as const;

const attentionResponseSchema = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: conditionSchema } },
} as const;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function toApiCondition(row: typeof healthConditions.$inferSelect) {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    code: row.code,
    severity: row.severity,
    penalty: row.penalty,
    summary: row.summary,
    detectedAt: row.detectedAt,
    evidence: row.evidenceJson ? (JSON.parse(row.evidenceJson) as unknown) : null,
  };
}

// Evidence links: the attention queue's entries carry entityType/entityId so the web UI can
// link straight to the container detail page (or a future host page) that justifies each
// condition -- per the UX spec's "every warning/score must link to supporting detail".
export function registerHealthScoreRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/health", { schema: { response: { 200: healthResponseSchema } } }, async () => {
    const thresholds = getThresholds(db);
    const active = db.select().from(healthConditions).where(eq(healthConditions.active, true)).orderBy(desc(healthConditions.detectedAt)).all();
    const { score, status } = summarizeConditions(active, thresholds);
    const sorted = [...active].sort(
      (a, b) => SEVERITY_RANK[a.severity as Severity] - SEVERITY_RANK[b.severity as Severity] || b.penalty - a.penalty,
    );
    return { status, score, conditions: sorted.map(toApiCondition) };
  });

  app.get("/api/v1/attention", { schema: { response: { 200: attentionResponseSchema } } }, async () => {
    const active = db.select().from(healthConditions).where(eq(healthConditions.active, true)).all();
    // Severity then recency, per the UX spec's attention-queue ordering.
    const sorted = [...active].sort(
      (a, b) =>
        SEVERITY_RANK[a.severity as Severity] - SEVERITY_RANK[b.severity as Severity] ||
        (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0),
    );
    return { items: sorted.map(toApiCondition) };
  });
}
