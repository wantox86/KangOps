import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { dependencyAnnotations, type DependencyAnnotation } from "../db/schema.js";

export function listAnnotations(db: DbClient): DependencyAnnotation[] {
  return db.select().from(dependencyAnnotations).all();
}

export function createAnnotation(db: DbClient, input: { fromContainerId: string; toContainerId: string; note: string | null }, nowIso: string): DependencyAnnotation {
  const inserted = db
    .insert(dependencyAnnotations)
    .values({ fromContainerId: input.fromContainerId, toContainerId: input.toContainerId, note: input.note, createdAt: nowIso })
    .returning()
    .all()[0];
  if (!inserted) throw new Error("failed to create dependency annotation");
  return inserted;
}

export function deleteAnnotation(db: DbClient, id: number): void {
  db.delete(dependencyAnnotations).where(eq(dependencyAnnotations.id, id)).run();
}
