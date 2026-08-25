import { z } from "zod";

// All env vars validated at boot -- fail fast with a clear message instead of a confusing
// runtime error later (e.g. a missing DB path surfacing as an obscure SQLite error).
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  // Persistent SQLite file path -- mounted as a volume in Compose. Defaults to a repo-local
  // path for `npm run dev`, overridden in docker-compose.yml to point at the named volume.
  DATABASE_PATH: z.string().default("./data/kangdocker.sqlite"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
