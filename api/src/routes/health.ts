import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

export function registerHealthRoutes(app: FastifyInstance, sqlite: Database.Database): void {
  // Suppress routine 200 request/response logs from 30s Docker healthchecks while preserving
  // warn/error logs (and without making the route louder than a quieter global level like "silent").
  const quietRouteOptions =
    app.log.level === "trace" || app.log.level === "debug" || app.log.level === "info"
      ? { logLevel: "warn" as const }
      : {};

  // Liveness: process is up and can respond. Never checks dependencies -- if it did, a slow
  // DB would make an orchestrator kill and restart a perfectly fine process.
  app.get("/healthz", quietRouteOptions, async () => {
    return { status: "ok" };
  });

  // Readiness: can this instance actually serve traffic right now. Checks the one dependency
  // that matters at Milestone 1 (SQLite) -- Docker/host collector readiness join this in
  // Milestone 2 once those adapters exist.
  app.get("/readyz", quietRouteOptions, async (_request, reply) => {
    try {
      sqlite.prepare("SELECT 1").get();
      return { status: "ok" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed: database unreachable");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
