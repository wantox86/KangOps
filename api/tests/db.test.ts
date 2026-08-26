import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { hosts } from "../src/db/schema.js";

describe("migrations + schema", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("applies migrations and allows inserting/reading a host row", () => {
    const now = new Date().toISOString();
    testDb.db.insert(hosts).values({
      id: "host-1",
      name: "macmini",
      status: "unknown",
      firstSeenAt: now,
      lastSeenAt: now,
    }).run();

    const [row] = testDb.db.select().from(hosts).where(eq(hosts.id, "host-1")).all();
    expect(row?.name).toBe("macmini");
  });

  it("runs in WAL mode", () => {
    const result = testDb.sqlite.pragma("journal_mode", { simple: true });
    expect(result).toBe("wal");
  });
});

// Milestone 5: "test upgrades/migrations, database persistence" -- exercises the actual startup
// path (index.ts calls runMigrations against a real file path, then a fresh createDb connects)
// against a database file that already has data and has already had all migrations applied
// once, the way a real upgrade (stop container, pull new image, start container against the
// same volume) behaves. A naive migration runner that isn't idempotent, or that wipes/corrupts
// existing rows, would fail this.
describe("upgrade / re-run migrations against an existing populated database", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kangdocker-upgrade-test-"));
    path = join(dir, "kangdocker.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves existing rows and stays queryable after migrations are re-applied", () => {
    // First "boot": fresh DB, migrations applied, one row written -- mirrors a real first run.
    runMigrations(path);
    const first = createDb(path);
    const now = new Date().toISOString();
    first.db
      .insert(hosts)
      .values({ id: "local", name: "macmini", status: "reachable", firstSeenAt: now, lastSeenAt: now })
      .run();
    first.sqlite.close();

    // Second "boot" against the same file (same volume, e.g. a container restart or an image
    // upgrade) -- runMigrations must be safe to call again without dropping/corrupting data.
    expect(() => runMigrations(path)).not.toThrow();

    const second = createDb(path);
    const [row] = second.db.select().from(hosts).where(eq(hosts.id, "local")).all();
    expect(row?.name).toBe("macmini");

    // A third re-run (e.g. a crash-loop that re-triggers the entrypoint before /readyz ever
    // reports ready) must also be a no-op, not a second failure on top of the first.
    expect(() => runMigrations(path)).not.toThrow();
    second.sqlite.close();
  });
});
