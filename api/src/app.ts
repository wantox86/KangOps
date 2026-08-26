import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { DbClient } from "./db/client.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSummaryRoutes } from "./routes/summary.js";
import { registerContainerRoutes } from "./routes/containers.js";

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

  return app;
}
