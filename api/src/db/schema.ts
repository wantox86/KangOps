import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Milestone 1 added hosts/settings. Milestone 2 added containers (current observed state) and
// events (normalized lifecycle events). Milestone 3 added metric_samples (+ an hourly
// downsampled table) and health_conditions -- enough for time-series charts, retention, and a
// deterministic health/attention engine. Milestone 4 adds alerts (webhook delivery records),
// backup_targets/backup_runs, image_metadata, and dependency_annotations -- see this file's
// Current State section for how each stays narrow/conservative rather than matching the spec's
// suggested columns verbatim. Milestone 7 adds agents (remote hosts that push their own metrics
// to this server instead of being polled).

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

// Delivery record for a webhook alert -- deliberately denormalized (entityType/entityId/code
// rather than a health_conditions FK) since a resolved condition's alert history should still
// read sensibly even though health_conditions rows are never deleted, only marked inactive; a
// plain FK would work too, but this mirrors metric_samples' "avoid a column that only makes
// sense per-adapter" spirit -- alerts should be understandable on their own. dedupeKey is the
// same `entityType:entityId:code` shape reconcile.ts already uses internally, reused here so
// alerts/notifier.ts can look up "when did we last alert on this" with one indexed query.
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    sentAt: text("sent_at").notNull(),
    error: text("error"),
  },
  (table) => ({
    dedupeKeySentAtIdx: index("alerts_dedupe_key_sent_at_idx").on(table.dedupeKey, table.sentAt),
  }),
);

// A user-configured backup signal to watch freshness of -- either filesystem-checked (checkPath)
// or purely webhook-reported (checkPath null), matching the spec's "configured filesystem
// freshness checks and a small authenticated webhook endpoint". token is the high-entropy
// scoped credential the external backup job authenticates its POST with (per CLAUDE.md's
// security checklist); it is generated once at creation time and returned in that response
// only -- GET /api/v1/backup-targets always masks it, same principle as never returning secrets
// from settings endpoints.
export const backupTargets = sqliteTable(
  "backup_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    expectedFrequencyMinutes: integer("expected_frequency_minutes").notNull(),
    checkPath: text("check_path"),
    token: text("token").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("backup_targets_token_idx").on(table.token),
  }),
);

// One row per reported/observed backup outcome. source is "webhook" for everything reported via
// POST /api/v1/webhooks/backup/:token; filesystem freshness (checkPath) is evaluated live from
// file mtime each cycle (backups/gather.ts) rather than synthesizing a run row every tick, so
// this table only grows on real reported events, not on every 20s collector cycle.
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    targetId: integer("target_id")
      .notNull()
      .references(() => backupTargets.id),
    occurredAt: text("occurred_at").notNull(),
    status: text("status").notNull(),
    message: text("message"),
    source: text("source").notNull(),
  },
  (table) => ({
    targetOccurredIdx: index("backup_runs_target_occurred_idx").on(table.targetId, table.occurredAt),
  }),
);

// Cached registry-check result per observed image ref ("repo:tag") -- Milestone 4's image/update
// center. Only populated when a user explicitly enables registry checks (settings key
// "registry_check_config"); never auto-connects to a registry, per CLAUDE.md's opt-in
// requirement. Only Docker Hub public (unauthenticated) image lookups are supported -- see
// images/parseRef.ts for why other registries are deliberately left unsupported rather than
// half-implemented.
export const imageMetadata = sqliteTable("image_metadata", {
  imageRef: text("image_ref").primaryKey(),
  registrySupported: integer("registry_supported", { mode: "boolean" }).notNull(),
  latestDigest: text("latest_digest"),
  updateAvailable: integer("update_available", { mode: "boolean" }),
  lastCheckedAt: text("last_checked_at"),
  checkError: text("check_error"),
  createdAt: text("created_at").notNull(),
});

// Explicit user-declared relationship between two containers -- the *only* source of edges in
// the dependency view (see dependencies/view.ts). Deliberately does not infer edges from shared
// networks or depends_on labels: the read adapter doesn't collect network membership today, and
// the spec explicitly warns against implying causal runtime dependencies from shared networks
// alone -- Compose-project co-membership is surfaced separately in the API as a labeled "weak,
// not causal" grouping computed directly from containers.composeProject, not stored here.
export const dependencyAnnotations = sqliteTable(
  "dependency_annotations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromContainerId: text("from_container_id")
      .notNull()
      .references(() => containers.dockerId),
    toContainerId: text("to_container_id")
      .notNull()
      .references(() => containers.dockerId),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    fromIdx: index("dependency_annotations_from_idx").on(table.fromContainerId),
    toIdx: index("dependency_annotations_to_idx").on(table.toContainerId),
  }),
);

// Milestone 7: one row per remote host that runs a KangOps agent. The agent is outbound-only --
// it POSTs to /api/v1/agents/:token/report on a schedule, so a monitored host never needs an
// inbound port opened (see agent/README.md). token is the scoped, high-entropy credential that
// both authenticates and identifies the reporting agent, generated once at creation and returned
// in that response only -- exactly the backup_targets.token pattern (routes/agents.ts masks it on
// every read). hostId FKs the hosts row created alongside the agent, so a registered-but-never-
// reported agent still shows up in GET /hosts as "unknown" rather than being invisible until its
// first report lands.
export const agents = sqliteTable(
  "agents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    token: text("token").notNull(),
    // What "on time" means for this agent -- staleness (agents/health.ts) is a multiple of this,
    // not a global constant, because a battery/low-power host may legitimately report far less
    // often than a always-on one.
    expectedIntervalSeconds: integer("expected_interval_seconds").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    agentVersion: text("agent_version"),
    lastReportAt: text("last_report_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("agents_token_idx").on(table.token),
    hostIdIdx: uniqueIndex("agents_host_id_idx").on(table.hostId),
  }),
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
export type BackupTarget = typeof backupTargets.$inferSelect;
export type NewBackupTarget = typeof backupTargets.$inferInsert;
export type BackupRun = typeof backupRuns.$inferSelect;
export type NewBackupRun = typeof backupRuns.$inferInsert;
export type ImageMetadataRow = typeof imageMetadata.$inferSelect;
export type NewImageMetadataRow = typeof imageMetadata.$inferInsert;
export type DependencyAnnotation = typeof dependencyAnnotations.$inferSelect;
export type NewDependencyAnnotation = typeof dependencyAnnotations.$inferInsert;

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
