import { describe, expect, it } from "vitest";
import { evaluateBackupHealth } from "../src/backups/freshness.js";
import type { BackupTargetStatus } from "../src/backups/types.js";

function target(overrides: Partial<BackupTargetStatus> = {}): BackupTargetStatus {
  return {
    id: 1,
    name: "nightly-db",
    expectedFrequencyMinutes: 60,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSuccessAt: "2026-01-01T00:00:00.000Z",
    lastRunWasFailure: false,
    lastFailureMessage: null,
    ...overrides,
  };
}

const NOW = "2026-01-01T02:00:00.000Z"; // 2h after the default lastSuccessAt above

describe("evaluateBackupHealth", () => {
  it("raises no condition for a fresh backup", () => {
    const conditions = evaluateBackupHealth([target({ lastSuccessAt: "2026-01-01T01:55:00.000Z" })], NOW);
    expect(conditions).toHaveLength(0);
  });

  it("raises a warning once age passes the warning multiplier (1.5x expected frequency)", () => {
    // 60min expected, warning at >=90min old; lastSuccessAt is 100min before NOW.
    const conditions = evaluateBackupHealth([target({ lastSuccessAt: "2026-01-01T00:20:00.000Z" })], NOW);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ code: "backup_stale", severity: "warning", penalty: 20, entityType: "backup_target", entityId: "1" });
  });

  it("raises a critical condition once age passes the critical multiplier (3x expected frequency)", () => {
    const conditions = evaluateBackupHealth([target({ lastSuccessAt: "2026-01-01T00:00:00.000Z" })], "2026-01-01T05:00:00.000Z");
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ code: "backup_stale", severity: "critical", penalty: 35 });
  });

  it("raises backup_missing when a target has never reported and the window has elapsed", () => {
    const conditions = evaluateBackupHealth([target({ lastSuccessAt: null, createdAt: "2026-01-01T00:00:00.000Z" })], NOW);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ code: "backup_missing", severity: "critical" });
  });

  it("does not raise backup_missing before the first expected window has elapsed", () => {
    const conditions = evaluateBackupHealth([target({ lastSuccessAt: null, createdAt: "2026-01-01T01:30:00.000Z" })], NOW);
    expect(conditions).toHaveLength(0);
  });

  it("raises backup_failed (and not backup_stale) when the latest run was a failure", () => {
    const conditions = evaluateBackupHealth([target({ lastRunWasFailure: true, lastFailureMessage: "disk full" })], NOW);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ code: "backup_failed", severity: "critical", penalty: 35 });
    expect(conditions[0]?.summary).toContain("disk full");
  });

  it("skips disabled targets entirely", () => {
    const conditions = evaluateBackupHealth([target({ enabled: false, lastSuccessAt: null })], NOW);
    expect(conditions).toHaveLength(0);
  });
});
