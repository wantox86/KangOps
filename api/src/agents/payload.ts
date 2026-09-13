import { z } from "zod";

// The agent report is external data crossing a trust boundary, so it gets validated at the edge
// exactly like every other inbound payload here (CLAUDE.md: "Validate all external data at the
// boundary"). The shape is deliberately small and flat -- it has to be producible by a POSIX
// shell script with awk/jq on a low-power box (see agent/agent.sh), not by a typed SDK.
//
// Every host metric is nullable: a host that can't read one of them (unreadable /proc field,
// df failing on an odd filesystem) must still be able to report the rest rather than having its
// whole report rejected. Same graceful-degradation rule as host/metrics.ts locally.
const nullableNonNegative = z.number().min(0).nullable().optional();

const reportedContainerSchema = z.object({
  dockerId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  image: z.string().min(1).max(500),
  imageDigest: z.string().max(200).nullable().optional(),
  state: z.enum(["running", "exited", "paused", "restarting", "created", "dead", "unknown"]),
  health: z.enum(["healthy", "unhealthy", "starting", "none"]),
  composeProject: z.string().max(200).nullable().optional(),
  composeService: z.string().max(200).nullable().optional(),
});

export const agentReportSchema = z.object({
  agentVersion: z.string().min(1).max(50),
  hostname: z.string().min(1).max(200).nullable().optional(),
  kernel: z.string().max(300).nullable().optional(),
  uptimeSeconds: z.number().int().min(0).nullable().optional(),
  host: z.object({
    cpuPercent: z.number().min(0).max(100).nullable().optional(),
    memoryUsedBytes: nullableNonNegative,
    memoryTotalBytes: nullableNonNegative,
    diskUsedBytes: nullableNonNegative,
    diskTotalBytes: nullableNonNegative,
  }),
  // Omitted entirely (not an empty array) when the agent has no Docker access -- an empty array
  // means "Docker is reachable and reports zero containers", which is a genuinely different fact
  // and makes ingest mark previously-seen containers as removed. See ingest.ts.
  // Capped so one misbehaving/hostile agent can't push an unbounded write batch per report.
  containers: z.array(reportedContainerSchema).max(500).optional(),
});

export type AgentReport = z.infer<typeof agentReportSchema>;
export type ReportedContainer = z.infer<typeof reportedContainerSchema>;
