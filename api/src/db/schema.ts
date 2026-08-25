import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Milestone 1 scope only: enough schema to prove the migration runner + persistent storage
// work end to end. containers/metric_samples/events/health_conditions/alerts/backup_* are
// deliberately NOT added yet -- they belong to Milestone 2/3/4 when the features that need
// them actually land (see CLAUDE.md's data model section for the full planned shape). Adding
// them now would just be idle, unused schema.

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("unknown"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  // Free-form metadata (e.g. OS, docker version) -- stored as JSON text; SQLite has no native
  // JSON column type, and this is genuinely unstructured/host-dependent data.
  metadataJson: text("metadata_json"),
});

// Non-secret settings only, per spec: "Store secrets in mounted environment/config files or an
// encrypted secret mechanism; never in browser-visible settings responses." Simple key/value --
// no need for a typed column-per-setting table at this scale.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type Setting = typeof settings.$inferSelect;
