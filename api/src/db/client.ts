import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export type SynchronousMode = "off" | "normal" | "full" | "extra";

export interface CreateDbOptions {
  // SQLite's fsync policy. Defaults to NORMAL (what WAL alone gives you). FULL fsyncs the WAL
  // on every commit, which is what you want when the database file lives on a block device
  // that can lose a page on an unclean host/VM shutdown -- NORMAL only syncs at checkpoints, so
  // a page written since the last checkpoint can land torn. See docs: PRAGMA synchronous.
  synchronous?: SynchronousMode | undefined;
}

export function createDb(
  databasePath: string,
  options: CreateDbOptions = {},
): { db: DbClient; sqlite: Database.Database } {
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
  // Must be set per-connection (unlike journal_mode, which is persistent in the file header),
  // so it applies to every createDb caller: index.ts, migrate.ts and test-helpers/db.ts.
  sqlite.pragma(`synchronous = ${(options.synchronous ?? "normal").toUpperCase()}`);
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
