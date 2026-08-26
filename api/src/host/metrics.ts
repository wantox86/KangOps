import { cpus, freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";

export interface HostMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
}

// Snapshot of cpus() at two points in time, ~sampleWindowMs apart, gives a real CPU percent --
// a single cpus() read only has cumulative counters since boot, which is not "current load".
function readCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

// Host metrics are collected live on each collector tick, not persisted as time-series yet --
// Milestone 2 only needs a current snapshot for the dashboard; metric_samples history is
// Milestone 3 scope (see CLAUDE.md's Current State notes).
export async function collectHostMetrics(sampleWindowMs = 200, diskPath = "/"): Promise<HostMetrics> {
  const before = readCpuTimes();
  await new Promise((resolve) => setTimeout(resolve, sampleWindowMs));
  const after = readCpuTimes();

  const idleDelta = after.idle - before.idle;
  const totalDelta = after.total - before.total;
  const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;

  const memoryTotalBytes = totalmem();
  const memoryUsedBytes = memoryTotalBytes - freemem();

  let diskUsedBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const stats = await statfs(diskPath);
    diskTotalBytes = stats.blocks * stats.bsize;
    diskUsedBytes = (stats.blocks - stats.bfree) * stats.bsize;
  } catch {
    // Not fatal -- some sandboxed/CI environments restrict statfs. Dashboard shows "unknown"
    // for disk rather than failing the whole collection cycle.
  }

  return { cpuPercent, memoryUsedBytes, memoryTotalBytes, diskUsedBytes, diskTotalBytes };
}
