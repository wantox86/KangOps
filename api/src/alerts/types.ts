import { z } from "zod";

export type WebhookFormat = "generic" | "discord" | "ntfy";

// User-configurable via GET/PUT /api/v1/settings/webhook (see webhookConfigRepo.ts). Mirrors
// health/types.ts's HealthThresholds pattern: a typed shape validated at the settings-table
// boundary. `url` is the one genuinely secret-shaped field here (an unguessable webhook URL is
// effectively a bearer credential for ntfy/Discord) -- see webhookConfigRepo.ts / routes for how
// it's masked on read.
export interface WebhookConfig {
  enabled: boolean;
  url: string;
  format: WebhookFormat;
  cooldownMinutes: number;
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  enabled: false,
  url: "",
  format: "generic",
  cooldownMinutes: 30,
};

export const webhookConfigSchema = z
  .object({
    enabled: z.boolean(),
    url: z.union([z.literal(""), z.string().url()]),
    format: z.enum(["generic", "discord", "ntfy"]),
    cooldownMinutes: z.number().int().min(1),
  })
  .refine((v) => !v.enabled || v.url.length > 0, { message: "url is required when enabled is true" });
