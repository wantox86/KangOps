// Normalized shape the rest of the app depends on -- deliberately much narrower than raw
// dockerode/Docker Engine API responses (per CLAUDE.md: "Do not expose raw Docker inspect
// payloads as a permanent public contract"). Both adapters (fixture + real socket) produce
// exactly this shape so nothing downstream cares which one is active.

export type ContainerState = "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "unknown";
export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";

export interface NormalizedContainer {
  dockerId: string;
  name: string;
  image: string;
  imageDigest: string | null;
  state: ContainerState;
  health: ContainerHealth;
  composeProject: string | null;
  composeService: string | null;
  startedAt: string | null;
  restartCount: number;
}

export interface ContainerStatsSample {
  dockerId: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
}

// Read-only surface only -- list/inspect/stats. No create/start/stop/remove methods exist on
// this interface anywhere in the codebase; that is the enforced trust boundary from
// CLAUDE.md's "Docker socket security" section, not just a convention.
export interface DockerReadAdapter {
  listContainers(): Promise<NormalizedContainer[]>;
  getStats(dockerId: string): Promise<ContainerStatsSample | null>;
}
