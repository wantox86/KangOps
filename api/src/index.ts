import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Migrations must complete before /readyz can report ready -- run them synchronously here,
  // not as a fire-and-forget, so a broken migration fails the container's startup/healthcheck
  // loudly instead of leaving the API up but silently unable to serve real data.
  runMigrations(config.DATABASE_PATH);

  const { sqlite } = createDb(config.DATABASE_PATH);
  const app = buildApp({ sqlite, logLevel: config.LOG_LEVEL });

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      sqlite.close();
      void app.close().then(() => process.exit(0));
    });
  }
}

void main();
