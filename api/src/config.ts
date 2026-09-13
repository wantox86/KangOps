import { z } from "zod";

// All env vars validated at boot -- fail fast with a clear message instead of a confusing
// runtime error later (e.g. a missing DB path surfacing as an obscure SQLite error).
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  // Persistent SQLite file path -- mounted as a volume in Compose. Defaults to a repo-local
  // path for `npm run dev`, overridden in docker-compose.yml to point at the named volume.
  DATABASE_PATH: z.string().default("./data/kangops.sqlite"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Milestone 2: which Docker read adapter to use. "fixture" replays recorded sample data (no
  // daemon needed -- local dev without Docker, and CI's api/web unit-test jobs which don't have
  // a socket-proxy running). "socket" talks to a real Docker API endpoint over DOCKER_HOST,
  // which in Compose points at the read-only docker-socket-proxy sidecar, never the raw socket.
  DOCKER_MODE: z.enum(["fixture", "socket"]).default("fixture"),
  DOCKER_HOST: z.string().default("tcp://docker-socket-proxy:2375"),

  // Collection loop tuning -- bounded so a hung/slow Docker API call can never wedge the loop
  // forever. Defaults land inside the UX spec's "modest default interval (15-30s)".
  COLLECTOR_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
  COLLECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  COLLECTOR_RETRIES: z.coerce.number().int().min(0).default(2),
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
