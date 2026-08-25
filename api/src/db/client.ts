import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(databasePath: string): { db: DbClient; sqlite: Database.Database } {
  // better-sqlite3 doesn't create parent directories -- Compose mounts a volume dir, but
  // `npm run dev` locally needs this or the first run fails with ENOENT.
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  // WAL mode: readers (the API's own queries) don't block the collector's writes and vice
  // versa -- matters once Milestone 2 adds a write-heavy collection loop alongside read
  // traffic from the dashboard.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
