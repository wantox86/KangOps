import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { DbClient } from "./db/client.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSummaryRoutes } from "./routes/summary.js";
import { registerContainerRoutes } from "./routes/containers.js";
import { registerHealthScoreRoutes } from "./routes/healthScore.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerDependencyRoutes } from "./routes/dependencies.js";
import { registerAgentRoutes } from "./routes/agents.js";

export interface BuildAppOptions {
  sqlite: Database.Database;
  db: DbClient;
  logLevel?: string;
}

// Separated from index.ts so tests can build a fully-wired app against an isolated test DB
// (see test-helpers/db.ts) without binding a real port -- Fastify's `.inject()` exercises the
// full route/plugin stack in-process.
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
  });

  registerHealthRoutes(app, options.sqlite);
  registerSummaryRoutes(app, options.db);
  registerContainerRoutes(app, options.db);
  registerHealthScoreRoutes(app, options.db);
  registerEventRoutes(app, options.db);
  registerMetricsRoutes(app, options.db);
  registerSettingsRoutes(app, options.db);
  registerHostRoutes(app, options.db);
  registerAlertRoutes(app, options.db);
  registerBackupRoutes(app, options.db);
  registerImageRoutes(app, options.db);
  registerDependencyRoutes(app, options.db);
  registerAgentRoutes(app, options.db);

  return app;
}
