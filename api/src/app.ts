import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSummaryRoutes } from "./routes/summary.js";

export interface BuildAppOptions {
  sqlite: Database.Database;
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
  registerSummaryRoutes(app);

  return app;
}
