import type { HealthConditionInput } from "../health/types.js";
import { STALE_CRITICAL_MULTIPLIER, STALE_WARNING_MULTIPLIER, type BackupTargetStatus } from "./types.js";

// Pure domain function (fixture-tested in tests/backupFreshness.test.ts) -- mirrors
// health/engine.ts's evaluateHealth shape (HealthConditionInput[]) so health/cycle.ts can merge
// its output straight into the same reconcile/persist/score pipeline without either module
// knowing about the other's entity type. entityType "backup_target" is new; entityId is the
// target's id as a string.
export function evaluateBackupHealth(targets: BackupTargetStatus[], nowIso: string): HealthConditionInput[] {
  const conditions: HealthConditionInput[] = [];
  const now = new Date(nowIso).getTime();

  for (const target of targets) {
    if (!target.enabled) continue;
    const entityId = String(target.id);

    if (target.lastRunWasFailure) {
      conditions.push({
        entityType: "backup_target",
        entityId,
        code: "backup_failed",
        severity: "critical",
        penalty: 35,
        summary: `Backup "${target.name}" reported failure${target.lastFailureMessage ? `: ${target.lastFailureMessage}` : ""}`,
        evidence: { name: target.name, message: target.lastFailureMessage },
      });
      continue; // A reported failure is the single most specific signal -- don't also raise a
      // separate staleness condition for the same target/cycle.
    }

    if (!target.lastSuccessAt) {
      const ageSinceCreatedMinutes = (now - new Date(target.createdAt).getTime()) / 60_000;
      if (ageSinceCreatedMinutes > target.expectedFrequencyMinutes) {
        conditions.push({
          entityType: "backup_target",
          entityId,
          code: "backup_missing",
          severity: "critical",
          penalty: 35,
          summary: `Backup "${target.name}" has never reported a successful run (expected every ${target.expectedFrequencyMinutes}m)`,
          evidence: { name: target.name, expectedFrequencyMinutes: target.expectedFrequencyMinutes },
        });
      }
      continue;
    }

    const ageMinutes = (now - new Date(target.lastSuccessAt).getTime()) / 60_000;
    if (ageMinutes >= target.expectedFrequencyMinutes * STALE_CRITICAL_MULTIPLIER) {
      conditions.push({
        entityType: "backup_target",
        entityId,
        code: "backup_stale",
        severity: "critical",
        penalty: 35,
        summary: `Backup "${target.name}" is ${Math.round(ageMinutes)}m old (expected every ${target.expectedFrequencyMinutes}m)`,
        evidence: { name: target.name, ageMinutes: Math.round(ageMinutes), expectedFrequencyMinutes: target.expectedFrequencyMinutes },
      });
    } else if (ageMinutes >= target.expectedFrequencyMinutes * STALE_WARNING_MULTIPLIER) {
      conditions.push({
        entityType: "backup_target",
        entityId,
        code: "backup_stale",
        severity: "warning",
        penalty: 20,
        summary: `Backup "${target.name}" is ${Math.round(ageMinutes)}m old (expected every ${target.expectedFrequencyMinutes}m)`,
        evidence: { name: target.name, ageMinutes: Math.round(ageMinutes), expectedFrequencyMinutes: target.expectedFrequencyMinutes },
      });
    }
  }

  return conditions;
}
