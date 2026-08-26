import containersFixture from "./fixtures/containers.json" with { type: "json" };
import statsFixture from "./fixtures/stats.json" with { type: "json" };
import type { ContainerStatsSample, DockerReadAdapter, NormalizedContainer } from "./types.js";

// Replays recorded sample data -- used for local dev without a Docker daemon, and any
// environment (e.g. the api/web unit-test CI jobs) that doesn't have docker-socket-proxy
// running. Implements the exact same DockerReadAdapter interface as the real adapter so the
// collector loop, routes, and tests never need to know which one is active.
export function createFixtureAdapter(): DockerReadAdapter {
  return {
    listContainers(): Promise<NormalizedContainer[]> {
      return Promise.resolve(containersFixture as NormalizedContainer[]);
    },
    getStats(dockerId: string): Promise<ContainerStatsSample | null> {
      const entry = (statsFixture as Record<string, Omit<ContainerStatsSample, "dockerId">>)[dockerId];
      if (!entry) return Promise.resolve(null);
      return Promise.resolve({ dockerId, ...entry });
    },
  };
}
