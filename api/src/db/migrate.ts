import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

// Standalone entrypoint (`npm run db:migrate`) as well as imported by index.ts at boot --
// migrations must be applied before the API starts serving `/readyz` as ready.
export function runMigrations(databasePath: string): void {
  const { db, sqlite } = createDb(databasePath);
  migrate(db, { migrationsFolder: "./drizzle" });
  sqlite.close();
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const config = loadConfig();
  runMigrations(config.DATABASE_PATH);
  console.log(`Migrations applied to ${config.DATABASE_PATH}`);
}
