import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { containers, events } from "../db/schema.js";
import type { DockerControlAdapter } from "../docker/types.js";

const ACTIONS = ["start", "stop", "restart"] as const;
type Action = (typeof ACTIONS)[number];

const resultSchema = {
  type: "object",
  required: ["ok", "action", "dockerId"],
  properties: {
    ok: { type: "boolean" },
    action: { type: "string" },
    dockerId: { type: "string" },
  },
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

async function recordAudit(
  db: DbClient,
  params: { hostId: string; dockerId: string; action: Action; ok: boolean; error?: string },
): Promise<void> {
  db.insert(events)
    .values({
      hostId: params.hostId,
      containerId: params.dockerId,
      occurredAt: nowIso(),
      source: "container_control",
      type: `container_${params.action}`,
      severity: params.ok ? "info" : "warning",
      summary: params.ok
        ? `Container ${params.action} requested via dashboard, succeeded`
        : `Container ${params.action} requested via dashboard, failed: ${params.error ?? "unknown error"}`,
      metadataJson: null,
    })
    .run();
}

// Milestone 8: the app's first genuinely Docker-mutating write surface (routes/containers.ts's
// PATCH only ever flips a local `critical` flag -- this actually calls start/stop/restart on
// real containers). Kept in its own file rather than folded into containers.ts because it's a
// different trust boundary: it requires `controlAdapter` to be wired in at all, and every
// action is unconditionally audit-logged here regardless of outcome (confirmation itself lives
// client-side in web/), per CLAUDE.md's "control action is separately enabled and visibly
// confirmed" principle. controlAdapter is undefined whenever CONTAINER_CONTROL_ENABLED=false
// (the default) -- every route below reports 501 in that case rather than silently no-op'ing.
export function registerContainerControlRoutes(app: FastifyInstance, db: DbClient, controlAdapter: DockerControlAdapter | undefined): void {
  for (const action of ACTIONS) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/containers/:id/${action}`,
      { schema: { response: { 200: resultSchema } } },
      async (request, reply) => {
        if (!controlAdapter) {
          return reply.code(501).send({ error: "not_enabled", message: "Container control is not enabled on this deployment" });
        }

        const row = db.select().from(containers).where(eq(containers.dockerId, request.params.id)).all()[0];
        if (!row) {
          return reply.code(404).send({ error: "not_found", message: "No container with that id" });
        }

        // Control only ever reaches the local Docker host's write-scoped proxy -- an
        // agent-reported host (BMAX, or any future remote) has no control path at all, by
        // design (see agent/README.md: the agent never mounts docker.sock). Reject explicitly
        // instead of attempting a call that could only ever fail confusingly.
        if (row.hostId !== "local") {
          return reply.code(400).send({ error: "unsupported_host", message: "Container control is only available for the local host" });
        }

        try {
          if (action === "start") await controlAdapter.startContainer(row.dockerId);
          else if (action === "stop") await controlAdapter.stopContainer(row.dockerId);
          else await controlAdapter.restartContainer(row.dockerId);

          await recordAudit(db, { hostId: row.hostId, dockerId: row.dockerId, action, ok: true });
          return { ok: true, action, dockerId: row.dockerId };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordAudit(db, { hostId: row.hostId, dockerId: row.dockerId, action, ok: false, error: message });
          return reply.code(502).send({ error: "docker_error", message });
        }
      },
    );
  }
}
