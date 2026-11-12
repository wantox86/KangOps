import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadConfig } from "../config.js";
import { createDb, type SynchronousMode } from "./client.js";

// Standalone entrypoint (`npm run db:migrate`) as well as imported by index.ts at boot --
// migrations must be applied before the API starts serving `/readyz` as ready.
export function runMigrations(databasePath: string, synchronous?: SynchronousMode): void {
  const { db, sqlite } = createDb(databasePath, { synchronous });
  migrate(db, { migrationsFolder: "./drizzle" });
  sqlite.close();
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const config = loadConfig();
  runMigrations(config.DATABASE_PATH, config.SQLITE_SYNCHRONOUS);
  console.log(`Migrations applied to ${config.DATABASE_PATH}`);
}
