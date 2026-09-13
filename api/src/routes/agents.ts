import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { gatherAgentSnapshots, isAgentStale } from "../agents/health.js";
import { ingestAgentReport } from "../agents/ingest.js";
import { agentReportSchema } from "../agents/payload.js";
import { createAgent, deleteAgent, findAgentById, findAgentByToken, listAgents, maskAgentToken } from "../agents/repo.js";
import { DEFAULT_AGENT_INTERVAL_SECONDS } from "../agents/types.js";
import { FixedWindowRateLimiter } from "../backups/rateLimiter.js";
import type { DbClient } from "../db/client.js";

const agentSchema = {
  type: "object",
  required: ["id", "name", "hostId", "expectedIntervalSeconds", "enabled", "tokenMasked", "agentVersion", "lastReportAt", "status"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    hostId: { type: "string" },
    expectedIntervalSeconds: { type: "integer" },
    enabled: { type: "boolean" },
    tokenMasked: { type: "string" },
    agentVersion: { type: ["string", "null"] },
    lastReportAt: { type: ["string", "null"] },
    status: { type: "string", enum: ["pending", "reporting", "stale"] },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: agentSchema } },
} as const;

const createdResponseSchema = {
  type: "object",
  required: ["id", "name", "hostId", "expectedIntervalSeconds", "token"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    hostId: { type: "string" },
    expectedIntervalSeconds: { type: "integer" },
    // The only response that ever carries the plaintext token, same rule as a backup target's:
    // copy it into the agent's config now, because no later read returns it.
    token: { type: "string" },
  },
} as const;

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  hostId: z.string().min(1).max(64).optional(),
  expectedIntervalSeconds: z.number().int().min(5).max(3600).optional(),
});

// An agent on the default 30s interval sends 2 reports/min; 60/min leaves room for a much faster
// configured interval plus retries while still stopping a wedged agent from hammering the API.
// Same blunt-protection intent as the backup webhook's limiter.
const reportLimiter = new FixedWindowRateLimiter(60, 60_000);

// Milestone 7's ingest surface. Like POST /webhooks/backup/:token, the scoped token in the path
// IS the authentication -- there is no session/user auth anywhere in KangOps yet (see
// docs/reverse-proxy-and-auth.md), so the agent registration/deletion endpoints below inherit
// whatever protection the deployment puts in front of the dashboard, exactly like /settings.
export function registerAgentRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/agents", { schema: { response: { 200: listResponseSchema } } }, async () => {
    const snapshots = new Map(gatherAgentSnapshots(db).map((s) => [s.hostId, s]));
    const nowIso = new Date().toISOString();

    return {
      items: listAgents(db).map((agent) => {
        const snapshot = snapshots.get(agent.hostId);
        const status = !agent.lastReportAt ? "pending" : snapshot && isAgentStale(snapshot, nowIso) ? "stale" : "reporting";
        return {
          id: agent.id,
          name: agent.name,
          hostId: agent.hostId,
          expectedIntervalSeconds: agent.expectedIntervalSeconds,
          enabled: agent.enabled,
          tokenMasked: maskAgentToken(agent.token),
          agentVersion: agent.agentVersion,
          lastReportAt: agent.lastReportAt,
          status,
        };
      }),
    };
  });

  app.post("/api/v1/agents", { schema: { response: { 201: createdResponseSchema } } }, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }

    const created = createAgent(
      db,
      {
        name: parsed.data.name,
        hostId: parsed.data.hostId,
        expectedIntervalSeconds: parsed.data.expectedIntervalSeconds ?? DEFAULT_AGENT_INTERVAL_SECONDS,
      },
      new Date().toISOString(),
    );

    return reply.code(201).send({
      id: created.id,
      name: created.name,
      hostId: created.hostId,
      expectedIntervalSeconds: created.expectedIntervalSeconds,
      token: created.token,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/agents/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid_id", message: "id must be an integer" });
    }
    if (!findAgentById(db, id)) {
      return reply.code(404).send({ error: "not_found", message: "no such agent" });
    }
    deleteAgent(db, id);
    return reply.code(204).send();
  });

  app.post<{ Params: { token: string } }>("/api/v1/agents/:token/report", async (request, reply) => {
    const { token } = request.params;

    if (!reportLimiter.allow(token)) {
      return reply.code(429).send({ error: "rate_limited", message: "too many reports for this agent, try again shortly" });
    }

    const agent = findAgentByToken(db, token);
    if (!agent) {
      // Same 401 whether malformed or merely unknown -- never confirm/deny token existence.
      return reply.code(401).send({ error: "invalid_token", message: "unknown or invalid agent token" });
    }
    if (!agent.enabled) {
      return reply.code(403).send({ error: "agent_disabled", message: "this agent is disabled" });
    }

    const parsed = agentReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }

    // The server stamps the observation time rather than trusting the agent's own clock: a
    // low-power box without NTP (or with a dead RTC) would otherwise poison the time-series and
    // the retention/downsampling windows that read it.
    const result = ingestAgentReport(db, agent, parsed.data, new Date().toISOString());

    return reply.code(202).send({ recorded: true, containersSynced: result.containersSynced });
  });
}
