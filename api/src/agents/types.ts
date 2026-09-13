import type { ContainerHealthInput } from "../health/types.js";

// Milestone 7. A remote host runs a small agent (see agent/ at the repo root) that collects its
// own host metrics + Docker container facts and PUSHES them here on a schedule. The direction
// matters: KangOps never dials out to a monitored host, so no homelab box needs an inbound port
// opened or its Docker socket exposed on the LAN -- the agent's outbound HTTPS/HTTP POST is the
// only channel, authenticated by a per-agent scoped token.

export const DEFAULT_AGENT_INTERVAL_SECONDS = 30;

// An agent is considered unreachable once it has missed this many consecutive expected reports.
// 3 is deliberately forgiving: a single dropped report (wifi blip, host busy) must not page
// anyone, but ~90s of silence at the default interval is a real signal.
export const STALE_INTERVAL_MULTIPLIER = 3;

// What the pure staleness/health evaluator needs to know about one agent, gathered by
// agents/health.ts's impure gatherAgentSnapshots. Mirrors the split every other module here uses
// (backups/gather.ts -> backups/freshness.ts, health/cycle.ts -> health/engine.ts).
export interface AgentSnapshot {
  hostId: string;
  name: string;
  enabled: boolean;
  expectedIntervalSeconds: number;
  lastReportAt: string | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  containers: ContainerHealthInput[];
}
