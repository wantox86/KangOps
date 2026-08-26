import { stat } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import type { DbClient } from "../db/client.js";
import type { BackupTarget } from "../db/schema.js";
import { listBackupTargets } from "./targetsRepo.js";
import { latestRunForTarget, latestSuccessForTarget } from "./runsRepo.js";
import type { BackupTargetStatus } from "./types.js";

// Filesystem freshness is evaluated live from mtime each cycle, not persisted as a backup_runs
// row every tick (that would grow the table unbounded at collector cadence for no benefit --
// see schema.ts's comment on backupRuns). A missing/unreadable path just means "no filesystem
// signal this cycle", not a hard error -- same graceful-degradation approach as
// host/metrics.ts's statfs() try/catch.
async function checkPathFreshness(checkPath: string): Promise<string | null> {
  try {
    const info = await stat(checkPath);
    return info.mtime.toISOString();
  } catch {
    return null;
  }
}

function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// Impure gathering step (mirrors health/cycle.ts's split between pure evaluateHealth and its own
// DB/adapter reads): builds the input the pure evaluateBackupHealth needs, from whichever
// combination of webhook-reported runs and filesystem mtime a target has configured.
export async function gatherBackupStatuses(db: DbClient, logger?: FastifyBaseLogger): Promise<BackupTargetStatus[]> {
  const targets = listBackupTargets(db);
  const statuses: BackupTargetStatus[] = [];

  for (const target of targets) {
    statuses.push(await gatherOne(db, target, logger));
  }

  return statuses;
}

async function gatherOne(db: DbClient, target: BackupTarget, logger?: FastifyBaseLogger): Promise<BackupTargetStatus> {
  const latestRun = latestRunForTarget(db, target.id);
  const latestWebhookSuccess = latestSuccessForTarget(db, target.id);

  let filesystemMtimeIso: string | null = null;
  if (target.checkPath) {
    try {
      filesystemMtimeIso = await checkPathFreshness(target.checkPath);
    } catch (err) {
      logger?.warn({ err, targetId: target.id }, "backup checkPath freshness check failed");
    }
  }

  const lastSuccessAt = newer(latestWebhookSuccess?.occurredAt ?? null, filesystemMtimeIso);
  const lastRunWasFailure = latestRun !== undefined && latestRun.status === "failure" && (!latestWebhookSuccess || latestRun.occurredAt > latestWebhookSuccess.occurredAt);

  return {
    id: target.id,
    name: target.name,
    expectedFrequencyMinutes: target.expectedFrequencyMinutes,
    enabled: target.enabled,
    createdAt: target.createdAt,
    lastSuccessAt,
    lastRunWasFailure,
    lastFailureMessage: lastRunWasFailure ? (latestRun?.message ?? null) : null,
  };
}
