import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { createFixtureAdapter } from "./docker/fixtureAdapter.js";
import { createDockerodeAdapter } from "./docker/dockerodeAdapter.js";
import { startCollector, type Collector } from "./collector/loop.js";

const LOCAL_HOST_ID = "local";

async function main(): Promise<void> {
  const config = loadConfig();

  // Migrations must complete before /readyz can report ready -- run them synchronously here,
  // not as a fire-and-forget, so a broken migration fails the container's startup/healthcheck
  // loudly instead of leaving the API up but silently unable to serve real data.
  runMigrations(config.DATABASE_PATH);

  const { db, sqlite } = createDb(config.DATABASE_PATH);
  const app = buildApp({ sqlite, db, logLevel: config.LOG_LEVEL });

  const adapter =
    config.DOCKER_MODE === "socket" ? createDockerodeAdapter(config.DOCKER_HOST, config.COLLECTOR_TIMEOUT_MS) : createFixtureAdapter();

  const collector: Collector = startCollector({
    db,
    adapter,
    hostId: LOCAL_HOST_ID,
    hostName: config.HOST,
    intervalMs: config.COLLECTOR_INTERVAL_MS,
    timeoutMs: config.COLLECTOR_TIMEOUT_MS,
    retries: config.COLLECTOR_RETRIES,
    logger: app.log,
  });
  // Kick off an immediate first cycle instead of waiting a full interval before any data exists.
  void collector.runOnce();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      collector.stop();
      sqlite.close();
      void app.close().then(() => process.exit(0));
    });
  }
}

void main();
