# KangDocker — Claude Code Guide

> This file is the original product spec (`~/Documents/CLAUDE-KangDocker.md`), copied into the
> repo as the source of truth for architecture/roadmap, with a **Current State** section
> prepended. Update the Current State section as milestones complete; the spec below stays
> mostly as planning guidance until a milestone's actual implementation diverges from it.

## Current State

**Milestone 3 (Health and history) — complete, 2026-08-26.**

- `api/src/health/`: pure deterministic health engine (`engine.ts`'s `evaluateHealth`, fixture/
  unit-tested in `tests/healthEngine.test.ts`) implementing the penalty table from this file's
  "Health score" section (critical container down: 35, non-critical unhealthy/restarting: 20,
  restart loop: 20, disk warning/critical: 10/30, host/container CPU or memory high: 10,
  collector unavailable: 20), clamped 0-100, banded into healthy/attention/critical via
  configurable `healthyMinScore`/`attentionMinScore`. `reconcile.ts` is a second pure function
  (mirrors `collector/diff.ts`'s pattern) that turns a fresh batch of conditions + currently-
  active `health_conditions` rows into insert/resolve decisions — new conditions get inserted,
  ongoing ones are left alone (no `detectedAt` reset), gone ones get `active=false` +
  `resolvedAt`. `cycle.ts` (`runHealthCycle`, impure) is the only piece that touches the DB/
  Docker adapter: it gathers a host metrics snapshot, per-container stats, restart counts in a
  rolling window (from `events`), calls the engine, persists `metric_samples`, and reconciles
  `health_conditions`. `thresholdsRepo.ts` reads/writes the threshold config as JSON in the
  existing `settings` table (key `health_thresholds`), zod-validated, falling back to
  `DEFAULT_THRESHOLDS` if missing/corrupt.
- `api/src/collector/loop.ts`: `runHealthCycle` + `metrics/runRetention.ts` now run after every
  collector tick (both the successful-sync branch and the unreachable-host catch branch, so
  `collector_unavailable` shows up as a real condition, not just a host status flag). A
  health/metrics failure is logged but never fails the container-sync path itself.
- `api/src/metrics/`: `retention.ts`'s `downsampleToHourly` is a pure function that folds raw
  `metric_samples` older than a cutoff into one `metric_samples_hourly` row per (host,
  container-or-null, hour) — avg/max for CPU, avg/max for memory, last-known limit/total bytes.
  `runRetention.ts` is the impure wrapper: runs every collector tick (cheap at homelab scale, no
  separate scheduler), default 24h raw retention / 30 days hourly retention
  (`DEFAULT_RETENTION_CONFIG`). This is what keeps `metric_samples` from growing unbounded.
- Schema: added `metric_samples`, `metric_samples_hourly`, `health_conditions` — see
  `api/drizzle/0002_oval_alex_power.sql`. Deliberately narrower than this file's suggested
  `metric_samples` columns: no net/block IO columns, since neither `DockerReadAdapter`
  implementation collects them yet (no dead always-null columns). `alerts`/`backup_*` still
  deferred to Milestone 4.
- API (`/api/v1`, all still read-only except one narrow config write — see below):
  `GET /health` (aggregate score/status/active conditions), `GET /attention` (active conditions
  sorted severity-then-recency, with evidence + `entityType`/`entityId` for UI deep-links),
  `GET /events` (global timeline, cursor-paginated via `before`, distinct from the per-container
  events already embedded in `GET /containers/:id`), `GET /containers/:id/metrics` and
  `GET /hosts/:id/metrics` (chart queries — raw resolution for ranges ≤24h, hourly rollups
  beyond that, since raw rows that old have already been folded/deleted by retention),
  `GET /hosts` (list), `GET`/`PUT /settings` (threshold config, zod-validated).
  `PATCH /containers/:id` (`{ critical: boolean }`) is the **only** write endpoint anywhere in
  this app, and it only ever flips a local config flag — never touches Docker. `GET /summary`
  now reports real `healthStatus`/`healthScore`/`reasons` from persisted `health_conditions`
  (previously hardcoded "unknown"/0 — see Milestone 2 notes below).
- `web/`: dashboard adds an attention-queue section (severity-badged, links to the relevant
  container), a critical-flag toggle button in the container detail panel, and a small metrics
  panel (current CPU%/memory% + a minimal inline-SVG sparkline, deliberately not a charting
  library — per this file's "avoid decorative charts; prefer a number, threshold, and trend").
- Tests: `tests/healthEngine.test.ts` (pure engine, fixture-based, one test per penalty/band/
  edge case), `tests/healthReconcile.test.ts` (pure reconcile), `tests/metricsRetention.test.ts`
  (pure downsampling), `tests/healthCycle.test.ts` (integration — exercises the real wiring
  through `startCollector`, including a critical-container-down condition opening then
  resolving across cycles), `tests/milestone3Routes.test.ts` (all new/changed routes). 68 tests
  total, all passing.
- Verified end-to-end via `docker compose up -d --build` **on the real MACMINI Docker host**
  (all 3 containers healthy): `/api/v1/summary` and `/api/v1/health` correctly scored the real
  homelab at "attention"/60 due to two genuinely-exited/unhealthy `pokjaw_postgres`/
  `pokjaw_redis` containers (dead project noted elsewhere in this file's homelab context) with
  matching entries in `/api/v1/attention`; `/api/v1/containers/:id/metrics` and
  `/api/v1/hosts/local/metrics` returned real CPU/memory/disk samples;
  `PATCH /api/v1/containers/:id` round-tripped a critical-flag change through
  `GET /api/v1/containers/:id`. Then torn down (`docker compose down -v`) — not left running as
  a standing service, same as Milestones 1 and 2.

### Known gotchas (Milestone 3, in addition to Milestone 2's below)

- **`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` bite on plain object/Record
  lookups used as fallbacks.** `RANGE_MS[key] ?? RANGE_MS[DEFAULT_KEY]` still types as
  `number | undefined` even though `DEFAULT_KEY` is a literal known-present key — TS doesn't
  narrow through the second lookup. Fixed in `routes/metrics.ts` by hoisting the default to its
  own `const DEFAULT_RANGE_MS = RANGE_MS[DEFAULT_RANGE] as number` once, not by scattering `!`
  assertions at each call site.
- **A `CollectorOptions`/`HealthCycleOptions`-style options object with an optional field passed
  a possibly-`undefined` value from a caller's own optional field trips `exactOptionalPropertyTypes`.**
  `diskPath?: string` rejected `diskPath: someOptionalString` from the caller; needed
  `diskPath?: string | undefined` on the interface instead of bare `diskPath?: string`.

**Milestone 2 (Read-only collection and visibility) — complete, 2026-08-26.**

- `api/src/docker/`: `DockerReadAdapter` interface (`listContainers`, `getStats` — read-only,
  no write/control method exists anywhere) with two implementations: `fixtureAdapter.ts`
  (replays `docker/fixtures/*.json`, used for local dev without Docker and whenever
  `DOCKER_MODE=fixture`) and `dockerodeAdapter.ts` (real adapter over `dockerode`, talks to
  whatever `DOCKER_HOST` points at — in Compose, always the read-only socket-proxy, never a raw
  socket).
- `api/src/host/metrics.ts`: live CPU/memory/disk snapshot via `node:os` + `fs.statfs` — not
  persisted as time-series yet (that's Milestone 3's `metric_samples`), just used for
  current-state reporting.
- `api/src/collector/loop.ts` + `diff.ts`: bounded collection loop (`COLLECTOR_INTERVAL_MS`,
  hard per-cycle `COLLECTOR_TIMEOUT_MS`, `COLLECTOR_RETRIES` retries) that lists containers each
  tick, diffs against the last-persisted row (pure function in `diff.ts`, independently tested),
  upserts `containers`, and inserts `events` rows for discoveries/state changes/health
  changes/restarts/removals. A failed cycle (after retries) marks the host `unreachable` and
  records a visible `collector_error` event instead of retrying silently forever.
- Schema: added `containers` (current observed state per Docker container ID) and `events`
  (normalized lifecycle/collector events) — see `api/drizzle/0001_safe_secret_warriors.sql`.
  `metric_samples`/`health_conditions`/`alerts`/`backup_*` still deferred to Milestone 3/4.
- API: `/api/v1/summary` now reports real `hostCount`/`containerCounts` from persisted data
  (`healthStatus`/`healthScore` stay "unknown"/0 — the real scoring engine is Milestone 3).
  New `GET /api/v1/containers` and `GET /api/v1/containers/:id` (with recent events, capped at
  50) — both return only the app's normalized shape, never raw Docker `inspect` payloads.
- `web/`: container list + click-through detail panel (state/health badge, recent events),
  still no router (not needed yet), responsive down to narrow phone widths.
- `docker-compose.yml`: new `docker-socket-proxy` service (`tecnativa/docker-socket-proxy`,
  env-allowlisted to `CONTAINERS`/`INFO`/`PING` only, `POST=0`) is the *only* thing that mounts
  `/var/run/docker.sock` (`:ro`) — `api` reaches it over `DOCKER_HOST=tcp://docker-socket-proxy:2375`
  and never touches the socket directly. See README's "Docker socket security" section and
  "Known gotchas" below for why this one service is NOT `read_only: true` (everything else
  still is).
- Tests: `api/tests/diff.test.ts` (pure diff logic), `collector.test.ts` (loop against the
  fixture adapter + a failing/hung adapter to exercise timeout/retry/error-event paths),
  `containers.test.ts` (both new routes + updated summary route), plus all Milestone 1 tests
  still passing.
- Verified end-to-end via `docker compose up -d --build` **on the real MACMINI Docker host**:
  all three containers healthy, collector picked up all ~20+ real homelab containers within one
  cycle, `/api/v1/containers` and `/api/v1/containers/:id` returned real data through the web
  proxy, then torn down (`docker compose down -v`) — not left running as a standing service.

### Known gotchas (Milestone 2, in addition to Milestone 1's below)

- **`tecnativa/docker-socket-proxy`'s entrypoint writes `haproxy.cfg` at container startup** by
  `sed`-ing its own baked-in template in place — this breaks under both `read_only: true` and a
  `tmpfs` mount over `/usr/local/etc/haproxy` (the tmpfs hides the template the sed step needs
  to read). Confirmed both by hand. Fix: this one service intentionally does NOT set
  `read_only: true`, unlike every other service in the compose file — `cap_drop: ALL` +
  `no-new-privileges` + the env allowlist are what still constrain it.
- **Drizzle 0.33's `sqliteTable` extra-config callback wants an object, not an array.**
  `(table) => [index(...)]` fails to typecheck on this version (`IndexBuilder[]` isn't
  `SQLiteTableExtraConfig`) even though that array form appears in some newer Drizzle docs/
  examples — use `(table) => ({ someIdx: index(...).on(table.col) })` instead.
- **`response.json()` on Fastify's `.inject()` result is generic (`json<T>()`), not `any`-cast.**
  Using `response.json() as T` trips `@typescript-eslint/no-unnecessary-type-assertion`
  (light-my-request already infers from a type param) — call `response.json<T>()` directly.

### Known gotchas (found during Milestone 1, worth knowing before touching this again)

- **Fresh named Docker volumes are root-owned; non-root containers can't write to them without
  help.** Both `api` and `web` hit this (SQLite couldn't open its file; nginx couldn't chown its
  own cache dirs) because `cap_drop: ALL` removes `CAP_CHOWN`/`CAP_SETUID`/`CAP_SETGID` even
  though the container *starts* as root. Fix: each service's entrypoint runs as root just long
  enough to `chown` its writable mount, then drops to a non-root user (`su-exec node` for the
  api; nginx's own official-image entrypoint does this internally for the `nginx` user) — and
  `docker-compose.yml` explicitly `cap_add`s exactly `CHOWN`, `SETUID`, `SETGID` back (not more)
  for both services. If you ever see `chown: Operation not permitted` or `SqliteError: unable to
  open database file` in this project again, this is almost certainly why.
- **`create-astro`/`npm create vite`-style scaffolding tools install newer majors than a spec
  might assume.** `eslint-plugin-react-hooks@4.x` (the version obvious to reach for) doesn't
  support ESLint 9's flat config at all — needed `^5.1.0`. If a fresh `npm install` in `web/`
  ever fails with an ESLint peer-dependency conflict, check this first.
- **TypeScript `rootDir` + a single tsconfig doesn't work once you have both `src/` and a
  sibling `tests/` directory with `strict`/`noEmit` build config.** `api/` splits into
  `tsconfig.json` (typecheck + lint, includes `src` + `tests`, `noEmit: true`) and
  `tsconfig.build.json` (extends the base, `rootDir: src`, `include: ["src"]` only, used solely
  by `npm run build`). Don't collapse these back into one file without re-testing both
  `npm run typecheck` and `npm run build`.
- **Host port 8085 for `web`, not 8080.** 8080 is already taken by `monthly-journal-api` if this
  ever runs on the homelab's actual Docker host (MACMINI) — see the top-level homelab
  `CLAUDE.md`. Override via `WEB_PORT` in `.env` if needed.

### Not yet deployed anywhere persistent

Milestone 1 was verified locally (`docker compose up`, then torn down + volume removed) — it is
not currently running as a standing service anywhere. Deciding where/whether to run this
continuously (most likely MACMINI, since that's the Docker host it's meant to observe) is a
separate decision, not made as part of this milestone.

---

## Project vision

KangDocker is a personal, local-first **Docker observability and control tower** for a homelab. It gives one person a calm, useful view of whether their services are healthy, why something changed, and what needs attention.

It is deliberately **not a Portainer clone**. The product prioritizes understanding and safe response over complete Docker administration. A user should be able to open the dashboard and answer:

1. Is my homelab healthy?
2. Which service needs attention, and why?
3. What changed recently?
4. Is capacity, backup, or an update becoming a problem?

## Product goals

- Make Docker service health, host capacity, and recent changes obvious in seconds.
- Be useful on a single Docker host with Docker Compose, without external SaaS.
- Preserve useful history so the dashboard answers trends, not only current state.
- Make risky actions explicit, narrow, auditable, and opt-in.
- Stay practical for a solo developer and modest homelab hardware.

## Non-goals

- Replacing Portainer, Docker Desktop, Kubernetes dashboards, or a full CI/CD system.
- A general-purpose container/image/volume/network editor.
- Automatic remediation, automatic upgrades, or arbitrary command execution in the MVP.
- Cloud accounts, mandatory telemetry, multi-tenancy, or enterprise RBAC.
- Requiring Prometheus, Grafana, or a separate database cluster for normal setup.

## Product principles

- **Local-first:** all collection, storage, and UI run in the user's homelab by default.
- **Privacy-first:** no data leaves the host unless a user explicitly configures an integration. Telemetry is opt-in.
- **Read-only by default:** observation never needs mutation privileges. Any control action is separately enabled and visibly confirmed.
- **Explain before act:** show the evidence behind health states and recommendations.
- **Useful over exhaustive:** prioritize signal, clear defaults, and fast navigation over exposing every Docker API field.
- **Graceful degradation:** missing optional capabilities (logs, update checks, AI, backups) must not break core monitoring.
- **Composable:** each capability has a small boundary and can be tested independently.

## Primary user and deployment assumptions

The primary user is a technical homelab owner running Docker/Compose on one Linux host, usually behind a reverse proxy. They value low resource use and can edit a Compose file. Start with a single node; do not design the MVP around a cluster.

## MVP scope

Deliver these capabilities first:

1. A dashboard with an overall health score, host CPU/memory/disk summary, and container status list.
2. Docker container discovery: name, image, state, healthcheck state, uptime, restart count, compose project/service labels, ports, and resource usage.
3. Per-container detail: current status, recent metrics, lifecycle events, inspect-derived metadata, and a bounded live/recent log view.
4. Short retention history for host/container metrics and normalized events.
5. Clear, deterministic health reasons (for example: `unhealthy`, repeated restart, stopped critical service, high CPU, low disk).
6. Local configuration for monitored/critical services, thresholds, retention, and alert destinations.
7. Basic alerting with deduplication/cooldown through a generic webhook and optional ntfy/Discord-compatible webhook presets.
8. Docker Compose deployment, onboarding, health checks, and a read-only security posture.

### Explicit MVP exclusions

- Start/stop/restart/recreate containers from the UI.
- Pulling images or applying updates.
- AI log analysis (provide an extension point only).
- Dependency visualization beyond a simple derived list.
- Backup provider integrations beyond recording/checking configured backup signals.
- Authentication beyond an intentional deployment recommendation (reverse proxy auth or local trusted network).
- Multi-node inventory.

## Phased roadmap

### Phase 0 — Foundation

- Repository skeleton, Compose deployment, configuration, database migrations, structured logging, and health endpoints.
- Read-only Docker collector and host metrics collector.

### Phase 1 — Useful dashboard (MVP)

- Dashboard, container table/detail, metrics history, event timeline, health scoring, and webhook alerting.
- Strong empty/error states and sample/demo data for local development.

### Phase 2 — Operations context

- Image/update center: compare running image digest/tag to available image metadata, never pull automatically.
- Dependency map derived from Compose labels, networks, `depends_on` metadata when available, and user annotations.
- Backup monitoring: configurable expected backup paths, timestamps, freshness thresholds, and success/failure webhook ingestion.
- Alert history, silencing/acknowledgement, and notification routing.

### Phase 3 — Assisted diagnosis and guarded control

- Optional AI explain: send only user-selected, redacted log/event context to a user-configured provider; display prompt/context and never run suggested commands automatically.
- Optional, separately enabled action service for a narrow allowlist such as restart a named container, with confirmation, audit events, and a least-privilege socket proxy.

### Phase 4 — Multi-node

- Per-node agents authenticate to a central web/API service using scoped credentials.
- Node inventory, node-aware filtering, aggregation, and offline-agent status.
- Do not begin this phase until the single-node data contracts are stable.

## UX requirements

### Dashboard

The dashboard must be glanceable and work well on desktop and a phone-sized browser. Above the fold show:

- Overall health: Healthy / Attention / Critical, numeric score, and the top 3 contributing reasons.
- Host capacity cards: CPU, memory, disk (including threshold state and trend when history exists).
- Service/container summary: running, unhealthy, restarting, stopped critical, and unknown.
- An attention queue sorted by severity then recency; every row states *what happened* and *why it matters*.
- A compact recent-events timeline.

Avoid decorative charts. Prefer a number, threshold, and trend. Every warning/score must link to supporting detail.

### Container monitoring

- Group containers by Compose project where labels exist; fall back gracefully for standalone containers.
- Support search, state/severity filters, and stable sorting.
- Treat Docker `healthcheck` and container `state` as distinct signals.
- Mark user-configured critical containers; a stopped or unhealthy critical container has strong impact.
- Store a container identity that survives rename/recreation analysis: Docker ID, name at observation, image digest when available, Compose project/service, and first/last seen timestamps.

### Metrics and history

- Collect host and container CPU, memory, network I/O, block I/O, and disk where permitted.
- Use a modest default interval (for example 15–30 seconds), configurable retention, and downsampling/aggregation for older data.
- Never create an unbounded raw time-series table. Enforce retention in a scheduled job.
- Charts need time-range selectors and a clear “no data” state.

### Events and timeline

Normalize Docker lifecycle events and derived events (health transitions, threshold crossings, alert sent/failed, collector errors). Record source, timestamp, entity, severity, machine-readable type, human-readable summary, and structured metadata.

### Logs and optional AI explain

- Log viewing is read-only, bounded by time/line count, and streamed/paginated safely.
- Do not persist all logs by default; persist only explicitly created diagnostic snapshots with retention.
- The future AI feature is opt-in, must disclose data sent, redact configured secrets/patterns, and return an explanation—not a command executor.

### Update/image center

Show image age, running tag/digest, known newer image metadata when a registry check is configured, and containers affected. “Update available” is informational; it must never pull/recreate containers in Phase 2.

### Dependency map

Present a simple graph/list of observed or declared relationships. Label confidence/source (Compose declaration, shared network, explicit user annotation). Do not imply causal runtime dependencies from shared networks alone.

### Backup monitoring

Backups are external facts, not assumptions. Start with configured filesystem freshness checks and a small authenticated webhook endpoint for backup jobs to report result. Display last success, age, expected frequency, and failure reason.

## Health score

Health must be transparent, deterministic, and configurable—not an opaque AI score.

- Start from 100. Clamp to 0–100.
- Apply penalties based on active conditions, with defaults documented in config:
  - critical container stopped/unhealthy: 35
  - non-critical unhealthy/restarting: 15–25
  - restart loop within a rolling window: 20
  - disk above warning/critical threshold: 10/30
  - sustained host/container CPU or memory threshold: 5–15
  - stale/failed backup for a required backup target: 20–35
  - collector/node unavailable: 20
- Avoid double-counting closely related signals; the score engine should deduplicate by condition/entity.
- Derive status bands: Healthy (80–100), Attention (50–79), Critical (0–49), configurable.
- Return the score alongside ordered contributing conditions, penalty values, timestamps, and links/identifiers to evidence.

Write the health score as a pure domain function with fixture-based tests.

## Architecture

Start as a modular monolith with clearly separated processes/modules:

```text
Docker daemon / host metrics
        │ read-only collection
        ▼
Collector (agent module) ──► API/domain service ──► SQLite storage
                                      │                    │
                                      ▼                    ▼
                                Web UI / REST API     retention jobs
                                      │
                                      └──► alert adapters (outbound webhook)
```

- **Collector/agent:** owns Docker API and host metric access, transforms raw data into versioned observations/events, and has no business/UI logic.
- **API/domain service:** owns validation, health calculation, retention, configuration, alerts, and query contracts.
- **Web UI:** read-focused interface using API contracts; it must not talk to the Docker socket directly.
- **Storage:** SQLite for the MVP, located on a persistent volume. Use migrations, WAL mode, indexes for time/entity queries, backups, and configurable retention.
- Keep a clean repository layout such as `apps/web`, `apps/api`, `packages/domain`, `packages/shared`, `infra/compose` only if it genuinely reduces coupling. A simpler single application layout is preferred until separation earns its cost.

### API boundaries

Version REST endpoints under `/api/v1`. Use explicit request/response schemas. Core resources:

- `GET /summary`, `/hosts`, `/containers`, `/containers/{id}`, `/containers/{id}/metrics`, `/containers/{id}/events`, `/containers/{id}/logs`
- `GET /events`, `GET /health`, `GET /images`, `GET /dependencies`, `GET /backups`
- `GET/PUT /settings` (protected; secrets never returned)
- `POST /webhooks/backup/{token}` (scoped token; validate payload and rate-limit)
- `GET /healthz`, `GET /readyz`

Use server-sent events only when polling demonstrably harms UX. Keep initial APIs pull-based and cache-friendly. Do not expose raw Docker inspect payloads as a permanent public contract.

## Docker socket security

The Docker socket is effectively root access. Treat it as the highest-risk integration.

- MVP collector needs only read operations; never mount the socket into the web UI container.
- Prefer a hardened Docker socket proxy with an allowlist for the exact read endpoints needed. If direct socket mounting is supported for convenience, label it prominently as elevated risk.
- Run application containers as a non-root user where compatible, use a read-only root filesystem where practical, drop Linux capabilities, and use `no-new-privileges`.
- Do not expose the Docker daemon TCP socket. Do not store Docker credentials or socket contents in logs.
- Any later write capability must be its own opt-in service/permission boundary—not an accidental extension of the collector.

## Recommended pragmatic tech stack

Favor a single-language TypeScript stack:

- Node.js LTS + TypeScript, strict mode.
- Fastify for the API (schema-first validation, low overhead).
- React + Vite + TypeScript for the web UI; use a small component system and accessible primitives rather than building a design system.
- SQLite via a mature migration-capable library/ORM (for example Drizzle) and `better-sqlite3` where deployment constraints allow.
- Docker Engine API client (`dockerode` or a thin typed client) and Node OS metrics library/native `/proc` reader behind an adapter.
- Vitest for unit/integration tests, Playwright for a small set of critical UI journeys, ESLint + Prettier, and Docker Compose for deployment.

This is a recommendation, not a mandate. If an existing repository already has a coherent stack, inspect it first and extend it unless the mismatch is material. Avoid microservices, message queues, Kubernetes, Redis, Prometheus, and GraphQL in the MVP.

## Data model (initial)

Use migrations and explicit timestamps in UTC. Suggested entities:

- `hosts`: id, name, status, first_seen_at, last_seen_at, metadata JSON.
- `containers`: id, host_id, docker_id, current_name, compose_project, compose_service, image_ref, image_digest, critical, first_seen_at, last_seen_at, current_state, current_health.
- `metric_samples`: id, host_id nullable, container_id nullable, observed_at, cpu_percent, memory_bytes, memory_limit_bytes, net_rx_bytes, net_tx_bytes, block_read_bytes, block_write_bytes, disk_used_bytes, disk_total_bytes.
- `events`: id, host_id, container_id nullable, occurred_at, source, type, severity, summary, metadata JSON, dedupe_key.
- `health_conditions`: id, entity_type, entity_id, code, severity, penalty, active, detected_at, resolved_at, evidence JSON.
- `alerts`: id, condition_id, destination, status, sent_at, error, dedupe_key.
- `backup_targets` and `backup_runs`: target configuration plus observed outcome/freshness.
- `settings`: non-secret settings only. Store secrets in mounted environment/config files or an encrypted secret mechanism; never in browser-visible settings responses.

Use foreign keys, index `(container_id, observed_at)`, `(host_id, observed_at)`, and event time/severity queries. Consider aggregated metric tables before raw history becomes expensive.

**Milestone 1 note:** only `hosts` and `settings` exist so far — see "Current State" above for why the rest is deferred, not skipped.

## Testing strategy

- Unit-test pure domain logic: health scoring, threshold evaluation, retention selection, event normalization, redaction, and alert deduplication.
- Integration-test API endpoints against an isolated SQLite database and mocked Docker/host adapters.
- Contract-test adapter outputs with recorded Docker API fixtures; never require a developer's real Docker daemon in CI.
- End-to-end test critical journeys: dashboard attention state, container detail, configuration change, and webhook backup result.
- Test failure modes: Docker unavailable, incomplete stats, corrupt/old migration, database full, registry timeout, alert failure.
- Keep test fixtures small, named, and representative of Compose labels and container state transitions.

## Application observability

- Emit structured JSON logs with request/correlation IDs; redact authorization headers, webhook tokens, environment values, and log payload secrets.
- Expose `/healthz` for process liveness and `/readyz` for database/collector readiness.
- Record collector failures as visible system events rather than silently retrying forever.
- Maintain lightweight internal metrics/counters (collection duration, errors, DB size, event queue/alert outcomes) and display diagnostics in a settings/status screen before adding external metrics integrations.

## Deployment

- Ship an example `compose.yml`, `.env.example`, and concise setup/troubleshooting documentation.
- Persist SQLite data in a named volume or documented host path; support explicit backup guidance.
- Pin image versions in examples. Include container healthchecks.
- Bind locally by default or clearly document reverse-proxy/TLS setup. Do not expose an unauthenticated dashboard directly to the internet.
- Make configuration reload/restart behavior explicit.
- Provide a small demo mode or fixtures so contributors can work without Docker access.

## Security checklist

Before calling a feature complete, verify:

- [ ] Docker socket access is read-only/allowlisted and absent from the UI container.
- [ ] No secrets appear in API responses, browser bundles, logs, events, diagnostics, or error messages.
- [ ] Webhook endpoints use high-entropy scoped tokens, payload validation, rate limiting, and event deduplication.
- [ ] Settings endpoints are protected in the chosen deployment model.
- [ ] Inputs are schema-validated; SQL is parameterized; UI output is escaped by default.
- [ ] Dependencies are pinned/updated deliberately and security-relevant changes are noted.
- [ ] Retention/deletion behavior is documented and does not erase needed configuration.
- [ ] Optional AI/network integrations are disabled by default and disclose outbound data.

## Coding conventions

- TypeScript strict mode; avoid `any`, hidden global state, and untyped JSON at boundaries.
- Keep domain logic framework-independent and side effects behind interfaces/adapters.
- Prefer small functions and explicit names over clever abstractions.
- Validate all external data at the boundary: Docker API, HTTP, environment, database JSON.
- UTC in storage/API; format times only in the UI.
- Use conventional HTTP statuses and structured error responses.
- Do not add a dependency for a trivial utility. Do not introduce a new architectural layer without a concrete current need.
- Add comments for non-obvious decisions, especially Docker semantics and security tradeoffs; do not narrate obvious code.

## Git workflow

- Work in small, focused commits using Conventional Commit-style messages, e.g. `feat(health): add deterministic score calculation`.
- Do not mix formatting, refactors, and behavior changes without a reason.
- Update documentation/config examples in the same change when behavior or setup changes.
- Before committing, run the relevant formatter, type checks, and targeted tests. Do not discard unrelated working-tree changes.

## Definition of done

A feature is done only when it:

- Meets an explicitly stated user-facing behavior and has an understandable empty/error state.
- Has schema validation and authorization/security implications considered.
- Includes relevant unit/integration coverage and passes formatting, type checking, and tests.
- Adds migrations/indexes/retention behavior where persistent data is involved.
- Emits useful diagnostics without leaking secrets.
- Updates API/config/docs when contracts change.
- Can be independently exercised without requiring unfinished roadmap work.

## Instructions for Claude Code

1. **Inspect before changing.** Read the repository structure, existing docs, package manifests, configuration, migrations, tests, and git status before proposing or editing code. Treat this file as guidance; existing project conventions win when they are coherent.
2. **Work incrementally.** State the smallest useful next slice, implement it, run focused verification, and report what changed plus what remains. Do not attempt all roadmap phases at once.
3. **Avoid overengineering.** Choose the simplest implementation that satisfies the current milestone. No speculative plugin systems, queues, distributed architecture, or generic abstractions.
4. **Keep features independently testable.** Put business rules behind pure functions/interfaces, mock Docker/host/network dependencies, and ship each vertical slice with focused tests.
5. **Respect the trust boundary.** Never add Docker write access, shell execution, external calls, or data collection beyond stated scope without explicitly surfacing the tradeoff and obtaining direction.
6. **Document decisions.** For material choices, add a brief entry to `docs/decisions/` (or the project’s established equivalent) covering context, choice, alternatives, and consequences. Do not create ceremonial ADRs for trivial implementation details.
7. **Protect existing work.** Do not overwrite/remove user changes or reformat unrelated files. If the worktree is dirty, limit edits to the requested surface and call out overlap risks.
8. **Verify honestly.** Run the narrowest relevant checks first, then broader checks when appropriate. State anything not run and why; never claim Docker integration was verified without an isolated fixture or real configured daemon.

## Initial implementation plan

### Milestone 1 — Runnable foundation

Outcome: a local Compose deployment starts a web/API service, has persistent SQLite storage, returns health/readiness endpoints, and displays a basic shell UI.

First tasks:

1. Inspect or establish the minimal repository structure and TypeScript tooling.
2. Add configuration parsing/validation, `.env.example`, and a non-secret settings model.
3. Add SQLite migration runner, initial schema, WAL configuration, and a repository test helper.
4. Add Fastify app with `/healthz`, `/readyz`, and a typed `/api/v1/summary` placeholder.
5. Add Compose deployment with persistent data, process healthcheck, non-root runtime where feasible, and no Docker socket yet.
6. Add lint, typecheck, unit-test commands and CI-friendly fixture/demo mode.

### Milestone 2 — Read-only collection and visibility

Outcome: the user can see current host/container facts safely.

1. Implement a Docker read adapter using fixtures first; list/inspect/events/stats only.
2. Implement host metrics adapter and a collection loop with bounded timeouts/retries.
3. Persist normalized container observations, current states, and lifecycle events.
4. Implement dashboard summary/container list/detail APIs and a simple responsive UI.
5. Add read-only socket-proxy/direct-socket deployment guidance and security tests/checklist.

### Milestone 3 — Health and history

Outcome: the dashboard explains attention and shows recent trends.

1. Implement pure health-condition and score engine with fixtures.
2. Persist metric samples, chart queries, retention job, and downsampling strategy.
3. Add attention queue, evidence links, container detail charts, and event timeline.
4. Add user configuration for critical services and thresholds.

### Milestone 4 — Notification and operational context

Outcome: meaningful issues are surfaced beyond the browser.

1. Implement webhook alert destination, cooldown/deduplication, delivery records, and tests.
2. Add backup target freshness checks plus authenticated backup-result webhook.
3. Add image metadata/update center behind explicit registry configuration.
4. Add a conservative dependency view with source/confidence labels.

### Milestone 5 — Harden and release

Outcome: a trustworthy first release for a real homelab.

1. Complete security review/checklist and privilege-minimizing Compose defaults.
2. Test upgrades/migrations, database persistence, unavailable Docker, and alert failures.
3. Write install, reverse-proxy/auth, backup, retention, and troubleshooting docs.
4. Test on a real non-production homelab with a rollback plan; capture follow-up issues before expanding scope.
