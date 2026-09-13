import { describe, expect, it } from "vitest";
import { evaluateAgentHealth, isAgentStale } from "../src/agents/health.js";
import { STALE_INTERVAL_MULTIPLIER, type AgentSnapshot } from "../src/agents/types.js";
import { DEFAULT_THRESHOLDS } from "../src/health/types.js";

const NOW = "2026-09-13T12:00:00.000Z";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    hostId: "bmax",
    name: "BMAX",
    enabled: true,
    expectedIntervalSeconds: 30,
    lastReportAt: "2026-09-13T11:59:50.000Z",
    cpuPercent: 5,
    memoryPercent: 20,
    diskPercent: 40,
    containers: [],
    ...overrides,
  };
}

describe("agent staleness", () => {
  it("is not stale when the last report is within the stale window", () => {
    // 30s interval * 3 = 90s tolerance; 10s old is comfortably fresh.
    expect(isAgentStale(snapshot(), NOW)).toBe(false);
  });

  it("is stale once the last report is older than interval * multiplier", () => {
    const old = new Date(new Date(NOW).getTime() - 30 * STALE_INTERVAL_MULTIPLIER * 1000 - 1000).toISOString();
    expect(isAgentStale(snapshot({ lastReportAt: old }), NOW)).toBe(true);
  });

  it("scales the window with the agent's own configured interval", () => {
    const fiveMinutesAgo = new Date(new Date(NOW).getTime() - 300_000).toISOString();
    expect(isAgentStale(snapshot({ lastReportAt: fiveMinutesAgo, expectedIntervalSeconds: 30 }), NOW)).toBe(true);
    expect(isAgentStale(snapshot({ lastReportAt: fiveMinutesAgo, expectedIntervalSeconds: 600 }), NOW)).toBe(false);
  });

  it("never treats a never-reported agent as stale", () => {
    expect(isAgentStale(snapshot({ lastReportAt: null }), NOW)).toBe(false);
  });
});

describe("evaluateAgentHealth", () => {
  it("produces no conditions for a healthy reporting agent", () => {
    expect(evaluateAgentHealth([snapshot()], DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it("produces no conditions for a registered agent that has never reported", () => {
    // Setup state, not a regression -- it stays visible via GET /hosts status "unknown" instead.
    expect(evaluateAgentHealth([snapshot({ lastReportAt: null })], DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it("skips disabled agents entirely", () => {
    const stale = new Date(new Date(NOW).getTime() - 3_600_000).toISOString();
    expect(evaluateAgentHealth([snapshot({ enabled: false, lastReportAt: stale })], DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it("opens agent_unreachable with a penalty of 20 when an agent goes silent", () => {
    const stale = new Date(new Date(NOW).getTime() - 3_600_000).toISOString();
    const conditions = evaluateAgentHealth([snapshot({ lastReportAt: stale })], DEFAULT_THRESHOLDS, NOW);

    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({
      entityType: "host",
      entityId: "bmax",
      code: "agent_unreachable",
      severity: "critical",
      penalty: 20,
    });
  });

  it("does not score stale metrics from a silent agent", () => {
    const stale = new Date(new Date(NOW).getTime() - 3_600_000).toISOString();
    const conditions = evaluateAgentHealth([snapshot({ lastReportAt: stale, diskPercent: 99, cpuPercent: 99 })], DEFAULT_THRESHOLDS, NOW);

    expect(conditions.map((c) => c.code)).toEqual(["agent_unreachable"]);
  });

  it("scores a remote host's capacity through the same engine as the local host", () => {
    const conditions = evaluateAgentHealth([snapshot({ diskPercent: 97 })], DEFAULT_THRESHOLDS, NOW);

    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ entityType: "host", entityId: "bmax", code: "disk_critical", penalty: 30 });
  });

  it("scores a remote host's unhealthy container and attributes it to that container", () => {
    const conditions = evaluateAgentHealth(
      [
        snapshot({
          containers: [
            { dockerId: "remote1", name: "immich_server", state: "running", health: "unhealthy", critical: false, restartsInWindow: 0, cpuPercent: null, memoryPercent: null },
          ],
        }),
      ],
      DEFAULT_THRESHOLDS,
      NOW,
    );

    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ entityType: "container", entityId: "remote1", code: "container_unhealthy" });
  });

  it("never reports collector_unavailable for an agent host (staleness is its liveness signal)", () => {
    const conditions = evaluateAgentHealth([snapshot({ diskPercent: 97 })], DEFAULT_THRESHOLDS, NOW);
    expect(conditions.map((c) => c.code)).not.toContain("collector_unavailable");
  });

  it("evaluates multiple agents independently", () => {
    const stale = new Date(new Date(NOW).getTime() - 3_600_000).toISOString();
    const conditions = evaluateAgentHealth(
      [snapshot(), snapshot({ hostId: "other", name: "Other", lastReportAt: stale })],
      DEFAULT_THRESHOLDS,
      NOW,
    );

    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ entityId: "other", code: "agent_unreachable" });
  });
});
