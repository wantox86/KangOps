import { describe, expect, it } from "vitest";
import { reconcileConditions } from "../src/health/reconcile.js";
import type { HealthCondition } from "../src/db/schema.js";
import type { HealthConditionInput } from "../src/health/types.js";

function existingRow(overrides: Partial<HealthCondition> = {}): HealthCondition {
  return {
    id: 1,
    entityType: "container",
    entityId: "c1",
    code: "container_unhealthy",
    severity: "warning",
    penalty: 20,
    active: true,
    summary: "old summary",
    detectedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    evidenceJson: null,
    ...overrides,
  };
}

function newCondition(overrides: Partial<HealthConditionInput> = {}): HealthConditionInput {
  return {
    entityType: "container",
    entityId: "c1",
    code: "container_unhealthy",
    severity: "warning",
    penalty: 20,
    summary: "new summary",
    evidence: { state: "running" },
    ...overrides,
  };
}

describe("reconcileConditions", () => {
  it("inserts a brand-new condition that has no existing active row", () => {
    const result = reconcileConditions([newCondition()], [], "2026-01-02T00:00:00.000Z");
    expect(result.toInsert).toHaveLength(1);
    expect(result.toInsert[0]).toMatchObject({ entityId: "c1", code: "container_unhealthy", detectedAt: "2026-01-02T00:00:00.000Z" });
    expect(result.toResolveIds).toHaveLength(0);
  });

  it("leaves an already-active condition alone (does not re-insert or reset detectedAt)", () => {
    const result = reconcileConditions([newCondition()], [existingRow()], "2026-01-02T00:00:00.000Z");
    expect(result.toInsert).toHaveLength(0);
    expect(result.toResolveIds).toHaveLength(0);
  });

  it("marks an active row for resolution when it's no longer present in the new conditions", () => {
    const result = reconcileConditions([], [existingRow()], "2026-01-02T00:00:00.000Z");
    expect(result.toResolveIds).toEqual([1]);
    expect(result.toInsert).toHaveLength(0);
  });

  it("handles a simultaneous resolve-one/insert-another cycle", () => {
    const result = reconcileConditions(
      [newCondition({ code: "restart_loop" })],
      [existingRow({ id: 5, code: "container_unhealthy" })],
      "2026-01-02T00:00:00.000Z",
    );
    expect(result.toResolveIds).toEqual([5]);
    expect(result.toInsert).toHaveLength(1);
    expect(result.toInsert[0]).toMatchObject({ code: "restart_loop" });
  });

  it("treats the same code on a different entity as a distinct condition", () => {
    const result = reconcileConditions([newCondition({ entityId: "c2" })], [existingRow({ entityId: "c1" })], "t");
    expect(result.toInsert).toHaveLength(1);
    expect(result.toResolveIds).toEqual([1]);
  });

  it("serializes evidence to JSON on insert", () => {
    const result = reconcileConditions([newCondition({ evidence: { cpuPercent: 91.2 } })], [], "t");
    expect(result.toInsert[0]?.evidenceJson).toBe(JSON.stringify({ cpuPercent: 91.2 }));
  });
});
