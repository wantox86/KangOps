import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { backupTargets, type BackupTarget, type NewBackupTarget } from "../db/schema.js";

// 32 bytes -> 64 hex chars: high-entropy per CLAUDE.md's security checklist ("high-entropy
// scoped tokens"). Generated once at target-creation time; never regenerated/exposed again
// (see routes/backups.ts -- GET always masks it).
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function createBackupTarget(db: DbClient, input: { name: string; expectedFrequencyMinutes: number; checkPath: string | null }, nowIso: string): BackupTarget {
  const token = generateToken();
  const values: NewBackupTarget = {
    name: input.name,
    expectedFrequencyMinutes: input.expectedFrequencyMinutes,
    checkPath: input.checkPath,
    token,
    enabled: true,
    createdAt: nowIso,
  };
  const inserted = db.insert(backupTargets).values(values).returning().all()[0];
  if (!inserted) throw new Error("failed to create backup target");
  return inserted;
}

export function listBackupTargets(db: DbClient): BackupTarget[] {
  return db.select().from(backupTargets).all();
}

export function findBackupTargetByToken(db: DbClient, token: string): BackupTarget | undefined {
  return db.select().from(backupTargets).where(eq(backupTargets.token, token)).all()[0];
}

export function deleteBackupTarget(db: DbClient, id: number): void {
  db.delete(backupTargets).where(eq(backupTargets.id, id)).run();
}

export function maskToken(token: string): string {
  return `${token.slice(0, 4)}${"*".repeat(8)}`;
}
