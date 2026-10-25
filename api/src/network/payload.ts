import { z } from "zod";

// External data crossing a trust boundary (CLAUDE.md: validate at the edge). The collector
// (agent/network.sh) already filters to online devices and normalises with jq, but the server
// does not trust that: MACs are re-normalised and every string is length-capped.
export const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

export function normalizeMac(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/-/g, ":");
  return MAC_RE.test(cleaned) ? cleaned : null;
}

const macSchema = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const mac = normalizeMac(value);
    if (!mac) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid mac address" });
      return z.NEVER;
    }
    return mac;
  });

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    });

const reportedDeviceSchema = z.object({
  mac: macSchema,
  ip: optionalText(64),
  hostname: optionalText(200),
  vendor: optionalText(200),
});

// Hard cap per snapshot so a misbehaving collector can't push an unbounded write batch.
export const MAX_DEVICES_PER_SNAPSHOT = 1024;

export const networkSnapshotSchema = z.object({
  collectorVersion: z.string().min(1).max(50),
  // Online devices only. Anything known but absent from this list is marked offline.
  devices: z.array(reportedDeviceSchema).max(MAX_DEVICES_PER_SNAPSHOT),
});

export type NetworkSnapshot = z.infer<typeof networkSnapshotSchema>;

export const aliasBodySchema = z.object({
  alias: z.string().max(100).nullable(),
});
