import Docker from "dockerode";
import type { ContainerHealth, ContainerState, ContainerStatsSample, DockerReadAdapter, NormalizedContainer } from "./types.js";

const KNOWN_STATES: ReadonlySet<string> = new Set(["running", "exited", "paused", "restarting", "created", "dead"]);

function toState(raw: string | undefined): ContainerState {
  if (raw && KNOWN_STATES.has(raw)) return raw as ContainerState;
  return "unknown";
}

function toHealth(raw: string | undefined): ContainerHealth {
  if (raw === "healthy" || raw === "unhealthy" || raw === "starting") return raw;
  return "none";
}

function normalizeInspect(inspect: Docker.ContainerInspectInfo): NormalizedContainer {
  const labels = inspect.Config?.Labels ?? {};
  return {
    dockerId: inspect.Id,
    // Docker prefixes container names with "/" -- strip for a display-friendly name.
    name: inspect.Name.replace(/^\//, ""),
    image: inspect.Config?.Image ?? inspect.Image,
    imageDigest: inspect.Image.startsWith("sha256:") ? inspect.Image : null,
    state: toState(inspect.State?.Status),
    health: toHealth(inspect.State?.Health?.Status),
    composeProject: labels["com.docker.compose.project"] ?? null,
    composeService: labels["com.docker.compose.service"] ?? null,
    startedAt: inspect.State?.Running ? (inspect.State?.StartedAt ?? null) : null,
    restartCount: inspect.RestartCount ?? 0,
  };
}

function computeCpuPercent(stats: Docker.ContainerStats): number | null {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const onlineCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  if (systemDelta <= 0 || cpuDelta < 0) return null;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

// Real adapter: talks to a Docker Engine API endpoint (in this project, always the read-only
// docker-socket-proxy sidecar over TCP -- see docker-compose.yml -- never a raw socket mount).
// Read-only surface only: listContainers + per-container inspect + stats. No write/control
// method exists here or anywhere in DockerReadAdapter.
export function createDockerodeAdapter(dockerHost: string, timeoutMs: number): DockerReadAdapter {
  const url = new URL(dockerHost);
  const docker = new Docker({
    host: url.hostname,
    port: url.port ? Number(url.port) : 2375,
    timeout: timeoutMs,
  });

  return {
    async listContainers(): Promise<NormalizedContainer[]> {
      const raw = await docker.listContainers({ all: true });
      const normalized: NormalizedContainer[] = [];
      for (const summary of raw) {
        const inspect = await docker.getContainer(summary.Id).inspect();
        normalized.push(normalizeInspect(inspect));
      }
      return normalized;
    },

    async getStats(dockerId: string): Promise<ContainerStatsSample | null> {
      try {
        const stats = (await docker.getContainer(dockerId).stats({ stream: false }));
        return {
          dockerId,
          cpuPercent: computeCpuPercent(stats),
          memoryBytes: stats.memory_stats.usage ?? null,
          memoryLimitBytes: stats.memory_stats.limit ?? null,
        };
      } catch {
        // A container that stopped between list and stats isn't an error worth surfacing --
        // just means no sample this cycle.
        return null;
      }
    },
  };
}
