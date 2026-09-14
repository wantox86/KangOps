import Docker from "dockerode";
import type { DockerControlAdapter } from "./types.js";

// Real control adapter: talks to the *write-scoped* docker-socket-proxy sidecar
// (docker-socket-proxy-control), never the read-only one and never a raw socket mount. That
// proxy's own allowlist (ALLOW_START/ALLOW_STOP/ALLOW_RESTARTS, CONTAINERS=0) is what actually
// enforces "only these 3 actions, nothing else" -- this adapter is a thin, narrow client on top
// of it, not the security boundary itself. See docker-compose.yml for why CONTAINERS must stay
// 0 on that proxy: tecnativa/docker-socket-proxy's CONTAINERS=1 allow-rule matches any method on
// any /containers/* path (not just GET), so combining it with POST=1 on the *same* proxy would
// silently reopen create/exec/remove/prune alongside the 3 intended actions.
export function createDockerodeControlAdapter(dockerControlHost: string, timeoutMs: number): DockerControlAdapter {
  const url = new URL(dockerControlHost);
  const docker = new Docker({
    host: url.hostname,
    port: url.port ? Number(url.port) : 2375,
    timeout: timeoutMs,
  });

  return {
    async startContainer(dockerId: string): Promise<void> {
      await docker.getContainer(dockerId).start();
    },
    async stopContainer(dockerId: string): Promise<void> {
      await docker.getContainer(dockerId).stop();
    },
    async restartContainer(dockerId: string): Promise<void> {
      await docker.getContainer(dockerId).restart();
    },
  };
}
