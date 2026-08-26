import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { imageMetadata, type ImageMetadataRow, type NewImageMetadataRow } from "../db/schema.js";

export function getImageMetadata(db: DbClient, imageRef: string): ImageMetadataRow | undefined {
  return db.select().from(imageMetadata).where(eq(imageMetadata.imageRef, imageRef)).all()[0];
}

export function listImageMetadata(db: DbClient): ImageMetadataRow[] {
  return db.select().from(imageMetadata).all();
}

export function upsertImageMetadata(db: DbClient, row: NewImageMetadataRow): void {
  db.insert(imageMetadata).values(row).onConflictDoUpdate({ target: imageMetadata.imageRef, set: row }).run();
}
