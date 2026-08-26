import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAnnotation, deleteAnnotation, listAnnotations } from "../dependencies/annotationsRepo.js";
import { buildDependencyView } from "../dependencies/view.js";
import type { DbClient } from "../db/client.js";
import { containers } from "../db/schema.js";

const groupSchema = {
  type: "object",
  required: ["composeProject", "source", "confidence", "note", "containerIds"],
  properties: {
    composeProject: { type: "string" },
    source: { type: "string" },
    confidence: { type: "string" },
    note: { type: "string" },
    containerIds: { type: "array", items: { type: "string" } },
  },
} as const;

const annotationSchema = {
  type: "object",
  required: ["id", "fromContainerId", "toContainerId", "note", "source", "confidence", "createdAt"],
  properties: {
    id: { type: "integer" },
    fromContainerId: { type: "string" },
    toContainerId: { type: "string" },
    note: { type: ["string", "null"] },
    source: { type: "string" },
    confidence: { type: "string" },
    createdAt: { type: "string" },
  },
} as const;

const dependencyViewResponseSchema = {
  type: "object",
  required: ["groups", "annotations"],
  properties: {
    groups: { type: "array", items: groupSchema },
    annotations: { type: "array", items: annotationSchema },
  },
} as const;

const createAnnotationBodySchema = z.object({
  fromContainerId: z.string().min(1),
  toContainerId: z.string().min(1),
  note: z.string().max(500).nullable().optional(),
});

// GET /api/v1/dependencies: see dependencies/view.ts for why this only ever surfaces two
// conservative sources (Compose-project co-membership, always labeled non-causal, and explicit
// user annotations) -- never inferred from shared networks (not even collected) or depends_on
// labels (also not collected by the read adapter).
export function registerDependencyRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/dependencies", { schema: { response: { 200: dependencyViewResponseSchema } } }, async () => {
    const containerRows = db.select().from(containers).all();
    const annotationRows = listAnnotations(db);
    return buildDependencyView(containerRows, annotationRows);
  });

  app.post("/api/v1/dependencies/annotations", { schema: { response: { 201: annotationSchema } } }, async (request, reply) => {
    const parsed = createAnnotationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }

    const existingIds = new Set(db.select().from(containers).all().map((c) => c.dockerId));
    if (!existingIds.has(parsed.data.fromContainerId) || !existingIds.has(parsed.data.toContainerId)) {
      return reply.code(404).send({ error: "not_found", message: "fromContainerId/toContainerId must reference known containers" });
    }

    const created = createAnnotation(db, { fromContainerId: parsed.data.fromContainerId, toContainerId: parsed.data.toContainerId, note: parsed.data.note ?? null }, new Date().toISOString());
    return reply.code(201).send({
      id: created.id,
      fromContainerId: created.fromContainerId,
      toContainerId: created.toContainerId,
      note: created.note,
      source: "user_annotation",
      confidence: "declared",
      createdAt: created.createdAt,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/dependencies/annotations/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid_id", message: "id must be an integer" });
    }
    deleteAnnotation(db, id);
    return reply.code(204).send();
  });
}
