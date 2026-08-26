import { desc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { backupRuns, type NewBackupRun } from "../db/schema.js";

export function recordBackupRun(db: DbClient, input: { targetId: number; status: "success" | "failure"; message: string | null; occurredAt: string }): void {
  const values: NewBackupRun = {
    targetId: input.targetId,
    occurredAt: input.occurredAt,
    status: input.status,
    message: input.message,
    source: "webhook",
  };
  db.insert(backupRuns).values(values).run();
}

export function latestRunForTarget(db: DbClient, targetId: number) {
  return db.select().from(backupRuns).where(eq(backupRuns.targetId, targetId)).orderBy(desc(backupRuns.occurredAt)).limit(1).all()[0];
}

export function latestSuccessForTarget(db: DbClient, targetId: number) {
  return db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.targetId, targetId))
    .orderBy(desc(backupRuns.occurredAt))
    .all()
    .find((r) => r.status === "success");
}
