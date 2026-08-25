import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/test-helpers/db.js";
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
