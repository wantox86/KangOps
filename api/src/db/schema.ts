import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Milestone 1 added hosts/settings. Milestone 2 adds containers (current observed state) and
// events (normalized lifecycle events) -- enough to persist "normalized container observations,
// current states, and lifecycle events" per the milestone scope. metric_samples/
// health_conditions/alerts/backup_* are still deferred to Milestone 3/4 (see CLAUDE.md).

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

// Current observed state per container -- one row per Docker container ID, upserted on every
// collector tick. Identity fields (dockerId/composeProject/composeService) let renamed/
// recreated containers still be tracked sensibly, per the UX spec's "container identity that
// survives rename/recreation" requirement.
export const containers = sqliteTable(
  "containers",
  {
    dockerId: text("docker_id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    currentName: text("current_name").notNull(),
    imageRef: text("image_ref").notNull(),
    imageDigest: text("image_digest"),
    composeProject: text("compose_project"),
    composeService: text("compose_service"),
    currentState: text("current_state").notNull(),
    currentHealth: text("current_health").notNull(),
    restartCount: integer("restart_count").notNull().default(0),
    critical: integer("critical", { mode: "boolean" }).notNull().default(false),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => ({
    hostIdIdx: index("containers_host_id_idx").on(table.hostId),
  }),
);

// Normalized lifecycle/collector events -- Docker state/health transitions plus collector
// errors (e.g. Docker API unreachable). containerId is nullable because host-level events
// (collector failure, host unreachable) aren't tied to a single container.
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    containerId: text("container_id").references(() => containers.dockerId),
    occurredAt: text("occurred_at").notNull(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    summary: text("summary").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    hostIdOccurredAtIdx: index("events_host_id_occurred_at_idx").on(table.hostId, table.occurredAt),
    containerIdOccurredAtIdx: index("events_container_id_occurred_at_idx").on(table.containerId, table.occurredAt),
  }),
);

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type Container = typeof containers.$inferSelect;
export type NewContainer = typeof containers.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
