import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type Database from "better-sqlite3";
import { createDb, type DbClient } from "../db/client.js";

export interface TestDb {
  db: DbClient;
  // Exposed alongside `db` (not just reachable through drizzle internals) because buildApp's
  // readiness check needs the raw better-sqlite3 handle directly -- reaching into drizzle's
  // internal `.session.client` would be a fragile dependency on an undocumented shape.
  sqlite: Database.Database;
  close: () => void;
}

// Real file in a temp dir, not `:memory:` -- better-sqlite3's WAL mode (used in production,
// see db/client.ts) needs a real file, and using the same code path in tests catches WAL-
// specific bugs that :memory: would hide.
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "kangops-test-"));
  const path = join(dir, "test.sqlite");
  const { db, sqlite } = createDb(path);
  migrate(db, { migrationsFolder: "./drizzle" });

  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
