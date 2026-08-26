import { describe, expect, it } from "vitest";
import { evaluateHealth, statusForScore, summarizeConditions } from "../src/health/engine.js";
import { DEFAULT_THRESHOLDS, type ContainerHealthInput, type HostHealthInput } from "../src/health/types.js";

const healthyHost: HostHealthInput = { hostId: "local", status: "reachable", cpuPercent: 10, memoryPercent: 20, diskPercent: 30 };

function container(overrides: Partial<ContainerHealthInput> = {}): ContainerHealthInput {
  return {
    dockerId: "c1",
    name: "web",
    state: "running",
    health: "healthy",
    critical: false,
    restartsInWindow: 0,
    cpuPercent: 5,
    memoryPercent: 10,
    ...overrides,
  };
}

describe("evaluateHealth", () => {
  it("returns a perfect score with no conditions when everything is nominal", () => {
    const result = evaluateHealth({ hosts: [healthyHost], containers: [container()] });
    expect(result.score).toBe(100);
    expect(result.status).toBe("healthy");
    expect(result.conditions).toHaveLength(0);
  });

  it("applies the critical-container-down penalty (35) and drops status accordingly", () => {
    const result = evaluateHealth({ hosts: [healthyHost], containers: [container({ critical: true, state: "exited" })] });
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]).toMatchObject({ code: "critical_container_down", penalty: 35, severity: "critical" });
    expect(result.score).toBe(65);
    expect(result.status).toBe("attention");
  });

  it("applies a smaller penalty for a non-critical unhealthy container", () => {
    const result = evaluateHealth({ hosts: [healthyHost], containers: [container({ health: "unhealthy" })] });
    expect(result.conditions[0]).toMatchObject({ code: "container_unhealthy", penalty: 20 });
    expect(result.score).toBe(80);
    expect(result.status).toBe("healthy");
  });

  it("does not double-count a critical container that is both down and unhealthy", () => {
    const result = evaluateHealth({ hosts: [healthyHost], containers: [container({ critical: true, state: "exited", health: "unhealthy" })] });
    expect(result.conditions.filter((c) => c.entityId === "c1")).toHaveLength(1);
  });

  it("flags a restart loop once restartsInWindow reaches the configured threshold", () => {
    const belowThreshold = evaluateHealth({ hosts: [healthyHost], containers: [container({ restartsInWindow: 2 })] });
    expect(belowThreshold.conditions).toHaveLength(0);

    const atThreshold = evaluateHealth({ hosts: [healthyHost], containers: [container({ restartsInWindow: 3 })] });
    expect(atThreshold.conditions[0]).toMatchObject({ code: "restart_loop", penalty: 20 });
  });

  it("escalates disk usage from warning (10) to critical (30) at the configured thresholds", () => {
    const warning = evaluateHealth({ hosts: [{ ...healthyHost, diskPercent: 85 }], containers: [] });
    expect(warning.conditions[0]).toMatchObject({ code: "disk_warning", penalty: 10, severity: "warning" });

    const critical = evaluateHealth({ hosts: [{ ...healthyHost, diskPercent: 95 }], containers: [] });
    expect(critical.conditions[0]).toMatchObject({ code: "disk_critical", penalty: 30, severity: "critical" });
  });

  it("flags collector_unavailable when a host is unreachable", () => {
    const result = evaluateHealth({ hosts: [{ ...healthyHost, status: "unreachable" }], containers: [] });
    expect(result.conditions[0]).toMatchObject({ code: "collector_unavailable", penalty: 20, severity: "critical" });
  });

  it("clamps score at 0 instead of going negative under many simultaneous conditions", () => {
    const result = evaluateHealth({
      hosts: [{ hostId: "local", status: "unreachable", cpuPercent: 99, memoryPercent: 99, diskPercent: 99 }],
      containers: [
        container({ dockerId: "c1", critical: true, state: "exited" }),
        container({ dockerId: "c2", critical: true, state: "exited" }),
        container({ dockerId: "c3", critical: true, state: "exited" }),
      ],
    });
    expect(result.score).toBe(0);
    expect(result.status).toBe("critical");
  });

  it("ignores null metric readings instead of treating them as zero or triggering thresholds", () => {
    const result = evaluateHealth({
      hosts: [{ hostId: "local", status: "reachable", cpuPercent: null, memoryPercent: null, diskPercent: null }],
      containers: [container({ cpuPercent: null, memoryPercent: null })],
    });
    expect(result.conditions).toHaveLength(0);
  });

  it("respects custom thresholds instead of only the defaults", () => {
    const strict = { ...DEFAULT_THRESHOLDS, cpuWarningPercent: 5 };
    const hostWithLowCpu: HostHealthInput = { ...healthyHost, cpuPercent: 0 };
    const result = evaluateHealth({ hosts: [hostWithLowCpu], containers: [container({ cpuPercent: 6 })] }, strict);
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]).toMatchObject({ code: "container_cpu_high" });
  });

  it("sorts conditions by severity (critical first) then penalty descending", () => {
    const result = evaluateHealth({
      hosts: [{ ...healthyHost, status: "unreachable", diskPercent: 85 }],
      containers: [container({ critical: true, state: "exited" })],
    });
    expect(result.conditions.map((c) => c.severity)).toEqual(["critical", "critical", "warning"]);
  });
});

describe("statusForScore", () => {
  it("bands scores into healthy/attention/critical using configured cutoffs", () => {
    expect(statusForScore(100, DEFAULT_THRESHOLDS)).toBe("healthy");
    expect(statusForScore(80, DEFAULT_THRESHOLDS)).toBe("healthy");
    expect(statusForScore(79, DEFAULT_THRESHOLDS)).toBe("attention");
    expect(statusForScore(50, DEFAULT_THRESHOLDS)).toBe("attention");
    expect(statusForScore(49, DEFAULT_THRESHOLDS)).toBe("critical");
    expect(statusForScore(0, DEFAULT_THRESHOLDS)).toBe("critical");
  });
});

describe("summarizeConditions", () => {
  it("computes the same score formula from persisted-condition-shaped rows", () => {
    const result = summarizeConditions([{ severity: "critical", penalty: 35 }, { severity: "warning", penalty: 10 }]);
    expect(result.score).toBe(55);
    expect(result.status).toBe("attention");
  });

  it("returns a perfect healthy score for no active conditions", () => {
    const result = summarizeConditions([]);
    expect(result).toEqual({ score: 100, status: "healthy" });
  });
});
