import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Milestone 1 added hosts/settings. Milestone 2 added containers (current observed state) and
// events (normalized lifecycle events). Milestone 3 adds metric_samples (+ an hourly downsampled
// table) and health_conditions -- enough for time-series charts, retention, and a deterministic
// health/attention engine. alerts/backup_* are still deferred to Milestone 4 (see CLAUDE.md).

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

// Raw time-series samples -- one row per host or per container per collector tick. containerId
// is null for host-level samples (mirrors events' host-vs-container nullability). Deliberately
// narrower than the spec's suggested column list: net/block IO aren't collected by either
// DockerReadAdapter implementation yet, so those columns aren't added until something actually
// populates them (no dead/always-null columns). Raw rows are short-lived -- see
// metricSamplesHourly and metrics/retention.ts for why this table never grows unbounded.
export const metricSamples = sqliteTable(
  "metric_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    containerId: text("container_id").references(() => containers.dockerId),
    observedAt: text("observed_at").notNull(),
    cpuPercent: real("cpu_percent"),
    memoryBytes: integer("memory_bytes"),
    memoryLimitBytes: integer("memory_limit_bytes"),
    diskUsedBytes: integer("disk_used_bytes"),
    diskTotalBytes: integer("disk_total_bytes"),
  },
  (table) => ({
    hostObservedIdx: index("metric_samples_host_observed_idx").on(table.hostId, table.observedAt),
    containerObservedIdx: index("metric_samples_container_observed_idx").on(table.containerId, table.observedAt),
  }),
);

// Downsampled hourly rollup -- the retention job (metrics/retention.ts) aggregates raw samples
// older than the raw retention window into one row per (entity, hour) here, then deletes the
// raw rows, so chart history beyond the raw window stays bounded and cheap instead of an
// unbounded raw table (per CLAUDE.md: "Never create an unbounded raw time-series table").
export const metricSamplesHourly = sqliteTable(
  "metric_samples_hourly",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    containerId: text("container_id").references(() => containers.dockerId),
    bucketStart: text("bucket_start").notNull(),
    sampleCount: integer("sample_count").notNull(),
    avgCpuPercent: real("avg_cpu_percent"),
    maxCpuPercent: real("max_cpu_percent"),
    avgMemoryBytes: integer("avg_memory_bytes"),
    maxMemoryBytes: integer("max_memory_bytes"),
    memoryLimitBytes: integer("memory_limit_bytes"),
    avgDiskUsedBytes: integer("avg_disk_used_bytes"),
    diskTotalBytes: integer("disk_total_bytes"),
  },
  (table) => ({
    hostBucketIdx: index("metric_samples_hourly_host_bucket_idx").on(table.hostId, table.bucketStart),
    containerBucketIdx: index("metric_samples_hourly_container_bucket_idx").on(table.containerId, table.bucketStart),
  }),
);

// Deterministic health engine output (api/src/health/engine.ts is the pure scoring function --
// this table is just its persisted, queryable trail). One row per (entityType, entityId, code)
// while active; "resolved" conditions are kept (active=false, resolvedAt set) rather than
// deleted so the event/attention history stays explainable.
export const healthConditions = sqliteTable(
  "health_conditions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    penalty: integer("penalty").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    summary: text("summary").notNull(),
    detectedAt: text("detected_at").notNull(),
    resolvedAt: text("resolved_at"),
    evidenceJson: text("evidence_json"),
  },
  (table) => ({
    entityIdx: index("health_conditions_entity_idx").on(table.entityType, table.entityId),
    activeIdx: index("health_conditions_active_idx").on(table.active, table.detectedAt),
  }),
);

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type Container = typeof containers.$inferSelect;
export type NewContainer = typeof containers.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type MetricSample = typeof metricSamples.$inferSelect;
export type NewMetricSample = typeof metricSamples.$inferInsert;
export type MetricSampleHourly = typeof metricSamplesHourly.$inferSelect;
export type NewMetricSampleHourly = typeof metricSamplesHourly.$inferInsert;
export type HealthCondition = typeof healthConditions.$inferSelect;
export type NewHealthCondition = typeof healthConditions.$inferInsert;
