import type { FastifyInstance } from "fastify";
import { FixedWindowRateLimiter } from "../backups/rateLimiter.js";
import type { DbClient } from "../db/client.js";
import { findAgentByToken } from "../agents/repo.js";
import { aliasBodySchema, networkSnapshotSchema, normalizeMac } from "../network/payload.js";
import { getLastSnapshotAt, ingestNetworkSnapshot, listNetworkDevices, setDeviceAlias } from "../network/repo.js";
import type { NetworkDevice } from "../db/schema.js";

// The collector polls every 60s by default; no snapshot for this long means the collector (or
// the router login) is down and the online/offline flags should not be trusted.
export const NETWORK_STALE_AFTER_MS = 5 * 60 * 1000;

const deviceSchema = {
  type: "object",
  required: ["mac", "ip", "hostname", "vendor", "alias", "name", "online", "firstSeenAt", "lastSeenAt"],
  properties: {
    mac: { type: "string" },
    ip: { type: ["string", "null"] },
    hostname: { type: ["string", "null"] },
    vendor: { type: ["string", "null"] },
    alias: { type: ["string", "null"] },
    // Display name: alias if set, else router hostname, else null.
    name: { type: ["string", "null"] },
    online: { type: "boolean" },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["items", "onlineCount", "totalCount", "lastSnapshotAt", "stale"],
  properties: {
    items: { type: "array", items: deviceSchema },
    onlineCount: { type: "integer" },
    totalCount: { type: "integer" },
    lastSnapshotAt: { type: ["string", "null"] },
    stale: { type: "boolean" },
  },
} as const;

function toView(d: NetworkDevice) {
  return { ...d, name: d.alias ?? d.hostname ?? null };
}

function ipSortKey(ip: string | null): number {
  if (!ip) return Number.MAX_SAFE_INTEGER;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return Number.MAX_SAFE_INTEGER;
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

const snapshotLimiter = new FixedWindowRateLimiter(30, 60_000);

// Like the agent report endpoint, the scoped agent token in the path IS the ingest auth. The
// read/alias endpoints have no auth (KangOps has none yet): this data is a LAN inventory, so the
// dashboard must stay off any public tunnel until auth exists.
export function registerNetworkRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/v1/network/devices", { schema: { response: { 200: listResponseSchema } } }, async () => {
    const devices = listNetworkDevices(db)
      // Online first, then by IP numerically, then MAC for stable order.
      .sort((a, b) => Number(b.online) - Number(a.online) || ipSortKey(a.ip) - ipSortKey(b.ip) || a.mac.localeCompare(b.mac));
    const lastSnapshotAt = getLastSnapshotAt(db);
    const stale = !lastSnapshotAt || Date.now() - new Date(lastSnapshotAt).getTime() > NETWORK_STALE_AFTER_MS;
    return {
      items: devices.map(toView),
      onlineCount: devices.filter((d) => d.online).length,
      totalCount: devices.length,
      lastSnapshotAt,
      stale,
    };
  });

  app.patch<{ Params: { mac: string } }>("/api/v1/network/devices/:mac", { schema: { response: { 200: deviceSchema } } }, async (request, reply) => {
    const mac = normalizeMac(decodeURIComponent(request.params.mac));
    if (!mac) return reply.code(400).send({ error: "invalid_mac", message: "mac must look like AA:BB:CC:DD:EE:FF" });
    const parsed = aliasBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const updated = setDeviceAlias(db, mac, parsed.data.alias);
    if (!updated) return reply.code(404).send({ error: "not_found", message: "no such device" });
    return toView(updated);
  });

  app.post<{ Params: { token: string } }>("/api/v1/agents/:token/network", async (request, reply) => {
    const { token } = request.params;
    if (!snapshotLimiter.allow(token)) {
      return reply.code(429).send({ error: "rate_limited", message: "too many snapshots for this agent, try again shortly" });
    }
    const agent = findAgentByToken(db, token);
    if (!agent) {
      return reply.code(401).send({ error: "invalid_token", message: "unknown or invalid agent token" });
    }
    if (!agent.enabled) {
      return reply.code(403).send({ error: "agent_disabled", message: "this agent is disabled" });
    }
    const parsed = networkSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const result = ingestNetworkSnapshot(db, parsed.data, new Date().toISOString());
    return reply.code(202).send({ recorded: true, ...result });
  });
}
