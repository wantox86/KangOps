// Multiplier constants against expectedFrequencyMinutes, not a full settings-table config --
// per CLAUDE.md's "avoid overengineering"/"no speculative generic abstractions", one pair of
// sane defaults is enough for a homelab-scale backup freshness check. Revisit only if a real
// need for per-target overrides shows up.
export const STALE_WARNING_MULTIPLIER = 1.5;
export const STALE_CRITICAL_MULTIPLIER = 3;

export interface BackupTargetStatus {
  id: number;
  name: string;
  expectedFrequencyMinutes: number;
  enabled: boolean;
  createdAt: string;
  // Most recent known-good timestamp, from either a "success" webhook run or a fresh checkPath
  // mtime (backups/gather.ts merges the two before this reaches the pure evaluator below).
  lastSuccessAt: string | null;
  // True only when the single most recent reported run (by occurredAt) was a failure and no
  // later success has arrived -- an old failure followed by a fresh success shouldn't still
  // read as "failed".
  lastRunWasFailure: boolean;
  lastFailureMessage: string | null;
}
