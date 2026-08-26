import { and, asc, eq, gte, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import { metricSamples, metricSamplesHourly } from "../db/schema.js";
import { DEFAULT_RETENTION_CONFIG } from "../metrics/retention.js";

const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const DEFAULT_RANGE = "24h";
const DEFAULT_RANGE_MS = RANGE_MS[DEFAULT_RANGE] as number;

const pointSchema = {
  type: "object",
  required: ["observedAt", "cpuPercent", "memoryBytes", "memoryLimitBytes"],
  properties: {
    observedAt: { type: "string" },
    cpuPercent: { type: ["number", "null"] },
    memoryBytes: { type: ["number", "null"] },
    memoryLimitBytes: { type: ["number", "null"] },
    diskUsedBytes: { type: ["number", "null"] },
    diskTotalBytes: { type: ["number", "null"] },
  },
} as const;

const metricsResponseSchema = {
  type: "object",
  required: ["range", "resolution", "points"],
  properties: {
    range: { type: "string" },
    resolution: { type: "string", enum: ["raw", "hourly"] },
    points: { type: "array", items: pointSchema },
  },
} as const;

function resolveRange(raw: string | undefined): { range: string; ms: number } {
  const range = raw && raw in RANGE_MS ? raw : DEFAULT_RANGE;
  return { range, ms: RANGE_MS[range] ?? DEFAULT_RANGE_MS };
}

// Chart query: raw samples for ranges within the raw-retention window (fine detail, per the UX
// spec's "time-range selectors"), hourly rollups for anything longer (raw rows that far back
// have already been folded/deleted by metrics/runRetention.ts). No "no data" special-casing
// needed here -- an empty `points` array is exactly what the UI's "no data" state should render.
function queryEntity(db: DbClient, hostId: string, containerId: string | null, ms: number) {
  const cutoffIso = new Date(Date.now() - ms).toISOString();
  const useRaw = ms <= DEFAULT_RETENTION_CONFIG.rawRetentionMs;

  if (useRaw) {
    const rows = db
      .select()
      .from(metricSamples)
      .where(and(eq(metricSamples.hostId, hostId), containerId ? eq(metricSamples.containerId, containerId) : isNull(metricSamples.containerId), gte(metricSamples.observedAt, cutoffIso)))
      .orderBy(asc(metricSamples.observedAt))
      .all();
    return {
      resolution: "raw" as const,
      points: rows.map((r) => ({
        observedAt: r.observedAt,
        cpuPercent: r.cpuPercent,
        memoryBytes: r.memoryBytes,
        memoryLimitBytes: r.memoryLimitBytes,
        diskUsedBytes: r.diskUsedBytes,
        diskTotalBytes: r.diskTotalBytes,
      })),
    };
  }

  const rows = db
    .select()
    .from(metricSamplesHourly)
    .where(
      and(
        eq(metricSamplesHourly.hostId, hostId),
        containerId ? eq(metricSamplesHourly.containerId, containerId) : isNull(metricSamplesHourly.containerId),
        gte(metricSamplesHourly.bucketStart, cutoffIso),
      ),
    )
    .orderBy(asc(metricSamplesHourly.bucketStart))
    .all();
  return {
    resolution: "hourly" as const,
    points: rows.map((r) => ({
      observedAt: r.bucketStart,
      cpuPercent: r.avgCpuPercent,
      memoryBytes: r.avgMemoryBytes,
      memoryLimitBytes: r.memoryLimitBytes,
      diskUsedBytes: r.avgDiskUsedBytes,
      diskTotalBytes: r.diskTotalBytes,
    })),
  };
}

export function registerMetricsRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    "/api/v1/containers/:id/metrics",
    { schema: { response: { 200: metricsResponseSchema } } },
    async (request) => {
      const { range, ms } = resolveRange(request.query.range);
      // hostId is fixed to "local" today (single-node MVP); the entity is identified by
      // containerId regardless, so this stays correct once multi-host arrives (Milestone 4).
      const result = queryEntity(db, "local", request.params.id, ms);
      return { range, ...result };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    "/api/v1/hosts/:id/metrics",
    { schema: { response: { 200: metricsResponseSchema } } },
    async (request) => {
      const { range, ms } = resolveRange(request.query.range);
      const result = queryEntity(db, request.params.id, null, ms);
      return { range, ...result };
    },
  );
}
