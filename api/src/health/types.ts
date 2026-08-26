export type HealthStatus = "healthy" | "attention" | "critical";
export type Severity = "info" | "warning" | "critical";

// User-configurable via GET/PUT /api/v1/settings (see health/thresholdsRepo.ts) -- defaults
// below match the penalty ranges from CLAUDE.md's "Health score" section.
export interface HealthThresholds {
  cpuWarningPercent: number;
  cpuCriticalPercent: number;
  memoryWarningPercent: number;
  memoryCriticalPercent: number;
  diskWarningPercent: number;
  diskCriticalPercent: number;
  restartLoopCount: number;
  restartLoopWindowMinutes: number;
  healthyMinScore: number;
  attentionMinScore: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  cpuWarningPercent: 80,
  cpuCriticalPercent: 95,
  memoryWarningPercent: 85,
  memoryCriticalPercent: 95,
  diskWarningPercent: 80,
  diskCriticalPercent: 90,
  restartLoopCount: 3,
  restartLoopWindowMinutes: 15,
  healthyMinScore: 80,
  attentionMinScore: 50,
};

// "backup_target" was added in Milestone 4 (backups/freshness.ts) -- health/engine.ts itself
// never produces that entityType, but health/cycle.ts merges backup conditions into the same
// HealthConditionInput[] pipeline (reconcile/persist/score), so the type has to allow it here.
export interface HealthConditionInput {
  entityType: "host" | "container" | "backup_target";
  entityId: string;
  code: string;
  severity: Severity;
  penalty: number;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface HostHealthInput {
  hostId: string;
  status: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
}

export interface ContainerHealthInput {
  dockerId: string;
  name: string;
  state: string;
  health: string;
  critical: boolean;
  restartsInWindow: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
}

export interface HealthEvalInput {
  hosts: HostHealthInput[];
  containers: ContainerHealthInput[];
}

export interface HealthResult {
  score: number;
  status: HealthStatus;
  conditions: HealthConditionInput[];
}
