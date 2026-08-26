import type { HealthCondition, NewHealthCondition } from "../db/schema.js";
import type { HealthConditionInput } from "./types.js";

export interface ReconcileResult {
  toInsert: NewHealthCondition[];
  toResolveIds: number[];
}

function conditionKey(entityType: string, entityId: string, code: string): string {
  return `${entityType}:${entityId}:${code}`;
}

// Pure function (mirrors collector/diff.ts's pattern): given this cycle's freshly computed
// conditions and the currently-active rows already in health_conditions, decide which new rows
// to insert and which active rows are no longer justified (and should be marked resolved).
// A condition that's still active on this cycle is left untouched -- detectedAt shouldn't
// reset just because the same problem is still ongoing.
export function reconcileConditions(newConditions: HealthConditionInput[], existingActive: HealthCondition[], nowIso: string): ReconcileResult {
  const existingKeys = new Set(existingActive.map((row) => conditionKey(row.entityType, row.entityId, row.code)));
  const newKeys = new Set(newConditions.map((c) => conditionKey(c.entityType, c.entityId, c.code)));

  const toInsert: NewHealthCondition[] = newConditions
    .filter((c) => !existingKeys.has(conditionKey(c.entityType, c.entityId, c.code)))
    .map((c) => ({
      entityType: c.entityType,
      entityId: c.entityId,
      code: c.code,
      severity: c.severity,
      penalty: c.penalty,
      active: true,
      summary: c.summary,
      detectedAt: nowIso,
      resolvedAt: null,
      evidenceJson: JSON.stringify(c.evidence),
    }));

  const toResolveIds = existingActive
    .filter((row) => !newKeys.has(conditionKey(row.entityType, row.entityId, row.code)))
    .map((row) => row.id);

  return { toInsert, toResolveIds };
}
