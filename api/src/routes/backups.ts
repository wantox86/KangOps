import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FixedWindowRateLimiter } from "../backups/rateLimiter.js";
import { gatherBackupStatuses } from "../backups/gather.js";
import { recordBackupRun } from "../backups/runsRepo.js";
import { createBackupTarget, deleteBackupTarget, findBackupTargetByToken, listBackupTargets, maskToken } from "../backups/targetsRepo.js";
import type { DbClient } from "../db/client.js";

const targetSchema = {
  type: "object",
  required: ["id", "name", "expectedFrequencyMinutes", "checkPath", "enabled", "tokenMasked", "lastSuccessAt", "lastRunWasFailure"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    expectedFrequencyMinutes: { type: "integer" },
    checkPath: { type: ["string", "null"] },
    enabled: { type: "boolean" },
    tokenMasked: { type: "string" },
    lastSuccessAt: { type: ["string", "null"] },
    lastRunWasFailure: { type: "boolean" },
  },
} as const;

const targetListResponseSchema = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: targetSchema } },
} as const;

const createdTargetResponseSchema = {
  type: "object",
  required: ["id", "name", "expectedFrequencyMinutes", "checkPath", "token"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    expectedFrequencyMinutes: { type: "integer" },
    checkPath: { type: ["string", "null"] },
    // The one and only response that ever carries the plaintext token -- see
    // backups/targetsRepo.ts's comment. Callers must copy it now; it's never returned again.
    token: { type: "string" },
  },
} as const;

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  expectedFrequencyMinutes: z.number().int().min(1),
  checkPath: z.string().min(1).nullable().optional(),
});

const backupResultBodySchema = z.object({
  status: z.enum(["success", "failure"]),
  message: z.string().max(2000).nullable().optional(),
});

// A backup job POSTing more than this within the window is almost certainly misconfigured
// (retrying in a loop) rather than a legitimate flood of distinct backup runs -- blunt
// protection per CLAUDE.md's security checklist ("rate limiting"), see backups/rateLimiter.ts.
const backupWebhookLimiter = new FixedWindowRateLimiter(10, 60_000);

// Implements the spec's exact `POST /webhooks/backup/{token}` shape (CLAUDE.md's API
// boundaries section) alongside CRUD for the targets that token belongs to. The token IS the
// auth mechanism (a scoped, high-entropy, per-target credential) -- there is no separate
// header/bearer scheme layered on top, matching the spec text directly.
export function registerBackupRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/backup-targets", { schema: { response: { 200: targetListResponseSchema } } }, async () => {
    const targets = listBackupTargets(db);
    const statuses = await gatherBackupStatuses(db, app.log);
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    return {
      items: targets.map((t) => ({
        id: t.id,
        name: t.name,
        expectedFrequencyMinutes: t.expectedFrequencyMinutes,
        checkPath: t.checkPath,
        enabled: t.enabled,
        tokenMasked: maskToken(t.token),
        lastSuccessAt: statusById.get(t.id)?.lastSuccessAt ?? null,
        lastRunWasFailure: statusById.get(t.id)?.lastRunWasFailure ?? false,
      })),
    };
  });

  app.post("/api/v1/backup-targets", { schema: { response: { 201: createdTargetResponseSchema } } }, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const created = createBackupTarget(db, { name: parsed.data.name, expectedFrequencyMinutes: parsed.data.expectedFrequencyMinutes, checkPath: parsed.data.checkPath ?? null }, new Date().toISOString());
    return reply.code(201).send({ id: created.id, name: created.name, expectedFrequencyMinutes: created.expectedFrequencyMinutes, checkPath: created.checkPath, token: created.token });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/backup-targets/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid_id", message: "id must be an integer" });
    }
    deleteBackupTarget(db, id);
    return reply.code(204).send();
  });

  app.post<{ Params: { token: string } }>("/api/v1/webhooks/backup/:token", async (request, reply) => {
    const { token } = request.params;

    if (!backupWebhookLimiter.allow(token)) {
      return reply.code(429).send({ error: "rate_limited", message: "too many backup reports for this target, try again shortly" });
    }

    const target = findBackupTargetByToken(db, token);
    if (!target) {
      // Deliberately the same 401 shape whether the token is malformed or just unknown -- never
      // confirm/deny token existence in the error message.
      return reply.code(401).send({ error: "invalid_token", message: "unknown or invalid backup token" });
    }

    const parsed = backupResultBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }

    recordBackupRun(db, { targetId: target.id, status: parsed.data.status, message: parsed.data.message ?? null, occurredAt: new Date().toISOString() });
    return reply.code(202).send({ recorded: true });
  });
}
