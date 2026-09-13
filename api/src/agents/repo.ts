import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { agents, hosts, type Agent, type NewAgent } from "../db/schema.js";
import { DEFAULT_AGENT_INTERVAL_SECONDS } from "./types.js";

// Same 32-byte/64-hex-char credential as backups/targetsRepo.ts's generateToken -- see that
// file for the reasoning. Not shared between the two modules on purpose: they're independent
// credential scopes, and a one-line helper isn't worth coupling them.
export function generateAgentToken(): string {
  return randomBytes(32).toString("hex");
}

export function maskAgentToken(token: string): string {
  return `${token.slice(0, 4)}${"*".repeat(8)}`;
}

// Host ids end up in URLs and metric queries, so keep them to a predictable slug rather than
// trusting whatever name the user typed.
export function slugifyHostId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : "agent";
}

export interface CreateAgentInput {
  name: string;
  hostId?: string | undefined;
  expectedIntervalSeconds?: number | undefined;
}

// Creates the hosts row up front, in the same call, rather than lazily on first report: a
// registered-but-not-yet-deployed agent should be visible in GET /hosts as "unknown" instead of
// invisible until its agent process happens to come online.
export function createAgent(db: DbClient, input: CreateAgentInput, nowIso: string): Agent {
  const hostId = input.hostId ? slugifyHostId(input.hostId) : slugifyHostId(input.name);

  const existingHost = db.select().from(hosts).where(eq(hosts.id, hostId)).all()[0];
  if (!existingHost) {
    db.insert(hosts)
      .values({
        id: hostId,
        name: input.name,
        status: "unknown",
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        metadataJson: JSON.stringify({ kind: "agent" }),
      })
      .run();
  }

  const values: NewAgent = {
    name: input.name,
    hostId,
    token: generateAgentToken(),
    expectedIntervalSeconds: input.expectedIntervalSeconds ?? DEFAULT_AGENT_INTERVAL_SECONDS,
    enabled: true,
    agentVersion: null,
    lastReportAt: null,
    createdAt: nowIso,
  };
  const inserted = db.insert(agents).values(values).returning().all()[0];
  if (!inserted) throw new Error("failed to create agent");
  return inserted;
}

export function listAgents(db: DbClient): Agent[] {
  return db.select().from(agents).all();
}

export function findAgentByToken(db: DbClient, token: string): Agent | undefined {
  return db.select().from(agents).where(eq(agents.token, token)).all()[0];
}

export function findAgentById(db: DbClient, id: number): Agent | undefined {
  return db.select().from(agents).where(eq(agents.id, id)).all()[0];
}

// Only the agent registration is deleted, never the hosts/containers/metric rows it produced --
// deleting those would silently erase real observed history (and break metric_samples' FK to
// hosts). The host simply stops being updated and, having no agent row left, stops being
// evaluated for staleness.
export function deleteAgent(db: DbClient, id: number): void {
  db.delete(agents).where(eq(agents.id, id)).run();
}

export function recordAgentReport(db: DbClient, id: number, agentVersion: string, nowIso: string): void {
  db.update(agents).set({ lastReportAt: nowIso, agentVersion }).where(eq(agents.id, id)).run();
}
