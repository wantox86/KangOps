import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { containers, events, hosts } from "../db/schema.js";
import type { DbClient } from "../db/client.js";
import type { DockerReadAdapter } from "../docker/types.js";
import { diffContainer, diffMissing } from "./diff.js";

export interface CollectorOptions {
  db: DbClient;
  adapter: DockerReadAdapter;
  hostId: string;
  hostName: string;
  intervalMs: number;
  timeoutMs: number;
  retries: number;
  logger: FastifyBaseLogger;
}

export interface Collector {
  stop: () => void;
  // Exposed for tests -- runs exactly one collection cycle without waiting for the interval.
  runOnce: () => Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, logger: FastifyBaseLogger): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        logger.warn({ err, attempt }, "collector cycle failed, retrying");
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function nowIso(): string {
  return new Date().toISOString();
}

// Bounded collection loop: each tick has a hard per-call timeout (so a hung Docker API call
// never wedges it forever) and a small retry budget before giving up and recording a visible
// "collector_error" event -- per CLAUDE.md: "Record collector failures as visible system events
// rather than silently retrying forever."
export function startCollector(options: CollectorOptions): Collector {
  const { db, adapter, hostId, hostName, intervalMs, timeoutMs, retries, logger } = options;

  function ensureHostRow(): void {
    const existing = db.select().from(hosts).where(eq(hosts.id, hostId)).all()[0];
    const ts = nowIso();
    if (!existing) {
      db.insert(hosts)
        .values({ id: hostId, name: hostName, status: "unknown", firstSeenAt: ts, lastSeenAt: ts })
        .run();
    }
  }

  async function runOnce(): Promise<void> {
    ensureHostRow();
    const ts = nowIso();

    try {
      const observed = await withRetry(() => withTimeout(adapter.listContainers(), timeoutMs, "listContainers"), retries, logger);

      const existingRows = db.select().from(containers).where(eq(containers.hostId, hostId)).all();
      const existingById = new Map(existingRows.map((row) => [row.dockerId, row]));
      const observedIds = new Set(observed.map((c) => c.dockerId));

      for (const container of observed) {
        const { upsert, events: newEvents } = diffContainer(container, existingById.get(container.dockerId), ts);
        upsert.hostId = hostId;
        db.insert(containers).values(upsert).onConflictDoUpdate({ target: containers.dockerId, set: upsert }).run();
        for (const event of newEvents) {
          db.insert(events).values({ ...event, hostId }).run();
        }
      }

      for (const row of existingRows) {
        if (!observedIds.has(row.dockerId) && row.currentState !== "removed") {
          const { upsert, events: newEvents } = diffMissing(row, ts);
          db.insert(containers).values(upsert).onConflictDoUpdate({ target: containers.dockerId, set: upsert }).run();
          for (const event of newEvents) {
            db.insert(events).values({ ...event, hostId }).run();
          }
        }
      }

      db.update(hosts).set({ status: "reachable", lastSeenAt: ts }).where(eq(hosts.id, hostId)).run();
    } catch (err) {
      logger.error({ err }, "collector cycle failed after retries");
      db.update(hosts).set({ status: "unreachable", lastSeenAt: ts }).where(eq(hosts.id, hostId)).run();
      db.insert(events)
        .values({
          hostId,
          containerId: null,
          occurredAt: ts,
          source: "collector",
          type: "collector_error",
          severity: "critical",
          summary: `Docker collection failed: ${err instanceof Error ? err.message : String(err)}`,
          metadataJson: null,
        })
        .run();
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
