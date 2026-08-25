import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

export function registerHealthRoutes(app: FastifyInstance, sqlite: Database.Database): void {
  // Liveness: process is up and can respond. Never checks dependencies -- if it did, a slow
  // DB would make an orchestrator kill and restart a perfectly fine process.
  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  // Readiness: can this instance actually serve traffic right now. Checks the one dependency
  // that matters at Milestone 1 (SQLite) -- Docker/host collector readiness join this in
  // Milestone 2 once those adapters exist.
  app.get("/readyz", async (_request, reply) => {
    try {
      sqlite.prepare("SELECT 1").get();
      return { status: "ok" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed: database unreachable");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
