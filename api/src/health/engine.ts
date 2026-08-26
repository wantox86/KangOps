import { DEFAULT_THRESHOLDS, type HealthConditionInput, type HealthEvalInput, type HealthResult, type HealthStatus, type HealthThresholds, type Severity } from "./types.js";

// Pure domain function: no DB, no Docker, no clock reads beyond what's passed in. Per
// CLAUDE.md's "Health score" section -- deterministic, configurable, fixture-testable.
// Callers (health/cycle.ts) are responsible for gathering HealthEvalInput from persisted state
// and for turning conditions into persisted health_conditions rows (health/reconcile.ts).

export function statusForScore(score: number, thresholds: HealthThresholds): HealthStatus {
  if (score >= thresholds.healthyMinScore) return "healthy";
  if (score >= thresholds.attentionMinScore) return "attention";
  return "critical";
}

export interface PersistedConditionLike {
  // Deliberately `string`, not `Severity` -- callers pass rows straight from the
  // health_conditions table (text column), and severity isn't used in the score formula below
  // (only penalty is), so a narrower type here would force pointless casts at every call site.
  severity: string;
  penalty: number;
}

// Reused by routes (summary/health/attention) that read *persisted* health_conditions rows
// rather than re-running the full evaluateHealth input-gathering -- same score formula, applied
// to whatever's currently active, so the dashboard and the engine can never silently disagree.
export function summarizeConditions(conditions: PersistedConditionLike[], thresholds: HealthThresholds = DEFAULT_THRESHOLDS): { score: number; status: HealthStatus } {
  const totalPenalty = conditions.reduce((sum, c) => sum + c.penalty, 0);
  const score = Math.max(0, Math.min(100, 100 - totalPenalty));
  return { score, status: statusForScore(score, thresholds) };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function evaluateHealth(input: HealthEvalInput, thresholds: HealthThresholds = DEFAULT_THRESHOLDS): HealthResult {
  const conditions: HealthConditionInput[] = [];

  for (const host of input.hosts) {
    if (host.status === "unreachable") {
      conditions.push({
        entityType: "host",
        entityId: host.hostId,
        code: "collector_unavailable",
        severity: "critical",
        penalty: 20,
        summary: `Host "${host.hostId}" is unreachable -- the collector can't observe it`,
        evidence: { status: host.status },
      });
    }

    if (host.diskPercent !== null) {
      if (host.diskPercent >= thresholds.diskCriticalPercent) {
        conditions.push({
          entityType: "host",
          entityId: host.hostId,
          code: "disk_critical",
          severity: "critical",
          penalty: 30,
          summary: `Host disk usage at ${host.diskPercent.toFixed(1)}% (critical threshold ${thresholds.diskCriticalPercent}%)`,
          evidence: { diskPercent: host.diskPercent, threshold: thresholds.diskCriticalPercent },
        });
      } else if (host.diskPercent >= thresholds.diskWarningPercent) {
        conditions.push({
          entityType: "host",
          entityId: host.hostId,
          code: "disk_warning",
          severity: "warning",
          penalty: 10,
          summary: `Host disk usage at ${host.diskPercent.toFixed(1)}% (warning threshold ${thresholds.diskWarningPercent}%)`,
          evidence: { diskPercent: host.diskPercent, threshold: thresholds.diskWarningPercent },
        });
      }
    }

    if (host.cpuPercent !== null && host.cpuPercent >= thresholds.cpuWarningPercent) {
      conditions.push({
        entityType: "host",
        entityId: host.hostId,
        code: "host_cpu_high",
        severity: host.cpuPercent >= thresholds.cpuCriticalPercent ? "critical" : "warning",
        penalty: 10,
        summary: `Host CPU at ${host.cpuPercent.toFixed(1)}% (warning threshold ${thresholds.cpuWarningPercent}%)`,
        evidence: { cpuPercent: host.cpuPercent, threshold: thresholds.cpuWarningPercent },
      });
    }

    if (host.memoryPercent !== null && host.memoryPercent >= thresholds.memoryWarningPercent) {
      conditions.push({
        entityType: "host",
        entityId: host.hostId,
        code: "host_memory_high",
        severity: host.memoryPercent >= thresholds.memoryCriticalPercent ? "critical" : "warning",
        penalty: 10,
        summary: `Host memory at ${host.memoryPercent.toFixed(1)}% (warning threshold ${thresholds.memoryWarningPercent}%)`,
        evidence: { memoryPercent: host.memoryPercent, threshold: thresholds.memoryWarningPercent },
      });
    }
  }

  for (const container of input.containers) {
    const isDown = container.state !== "running" && container.state !== "created";
    const isUnhealthy = container.health === "unhealthy";
    const isRestarting = container.state === "restarting";

    // Docker `healthcheck` and container `state` are distinct signals per the UX spec -- both
    // feed the same "is this container in trouble" condition, but the penalty differs sharply
    // by whether the container is marked critical (per CLAUDE.md's "critical container
    // stopped/unhealthy: 35" vs "non-critical unhealthy/restarting: 15-25").
    if (container.critical && (isDown || isUnhealthy)) {
      conditions.push({
        entityType: "container",
        entityId: container.dockerId,
        code: "critical_container_down",
        severity: "critical",
        penalty: 35,
        summary: `Critical container "${container.name}" is ${isUnhealthy ? "unhealthy" : container.state}`,
        evidence: { state: container.state, health: container.health, critical: true },
      });
    } else if (!container.critical && (isUnhealthy || isRestarting)) {
      conditions.push({
        entityType: "container",
        entityId: container.dockerId,
        code: "container_unhealthy",
        severity: "warning",
        penalty: 20,
        summary: `Container "${container.name}" is ${isUnhealthy ? "unhealthy" : container.state}`,
        evidence: { state: container.state, health: container.health, critical: false },
      });
    }

    if (container.restartsInWindow >= thresholds.restartLoopCount) {
      conditions.push({
        entityType: "container",
        entityId: container.dockerId,
        code: "restart_loop",
        severity: "warning",
        penalty: 20,
        summary: `Container "${container.name}" restarted ${container.restartsInWindow} times in the last ${thresholds.restartLoopWindowMinutes}m`,
        evidence: { restartsInWindow: container.restartsInWindow, windowMinutes: thresholds.restartLoopWindowMinutes },
      });
    }

    if (container.cpuPercent !== null && container.cpuPercent >= thresholds.cpuWarningPercent) {
      conditions.push({
        entityType: "container",
        entityId: container.dockerId,
        code: "container_cpu_high",
        severity: container.cpuPercent >= thresholds.cpuCriticalPercent ? "critical" : "warning",
        penalty: 10,
        summary: `Container "${container.name}" CPU at ${container.cpuPercent.toFixed(1)}%`,
        evidence: { cpuPercent: container.cpuPercent, threshold: thresholds.cpuWarningPercent },
      });
    }

    if (container.memoryPercent !== null && container.memoryPercent >= thresholds.memoryWarningPercent) {
      conditions.push({
        entityType: "container",
        entityId: container.dockerId,
        code: "container_memory_high",
        severity: container.memoryPercent >= thresholds.memoryCriticalPercent ? "critical" : "warning",
        penalty: 10,
        summary: `Container "${container.name}" memory at ${container.memoryPercent.toFixed(1)}%`,
        evidence: { memoryPercent: container.memoryPercent, threshold: thresholds.memoryWarningPercent },
      });
    }
  }

  // Conditions are constructed at most once per (entity, code) above, so there's nothing to
  // deduplicate -- "avoid double-counting closely related signals" is satisfied by construction
  // (e.g. a critical container only ever contributes critical_container_down, never both that
  // and container_unhealthy).
  const totalPenalty = conditions.reduce((sum, condition) => sum + condition.penalty, 0);
  const score = Math.max(0, Math.min(100, 100 - totalPenalty));
  const status = statusForScore(score, thresholds);

  conditions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.penalty - a.penalty);

  return { score, status, conditions };
}
