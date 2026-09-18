# KangOps — Claude Code Guide

> This file is the original product spec (`~/Documents/CLAUDE-KangDocker.md`, the project's
> original name — the file itself was not renamed on disk), copied into the repo as the source
> of truth for architecture/roadmap, with a **Current State** section prepended. Update the
> Current State section as milestones complete; the spec below stays mostly as planning
> guidance until a milestone's actual implementation diverges from it.
>
> **KangOps is the renamed evolution of KangDocker** (rebranded Milestone 6, 2026-09-13) — same
> codebase/history, broader long-term vision (a general homelab operations dashboard: host/
> service/storage/network monitoring, auth, container control, etc., all out of scope for now).
> Docker observability/control (this spec) is its first and currently only module. Every
> "KangDocker" mention below was the product's name at the time each milestone was written;
> historical entries are left factually as-is except for the name swap itself.

## Current State

**Portal page — added 2026-09-18 (after Milestone 8, outside the milestone numbering).**

A curated link hub for every homelab service, reachable at `#/portal` (linked from the main
page tagline). Serves `GET /api/v1/portal` from a **static, checked-in catalog** at
`api/src/portal/catalog.ts` — deliberately not DB rows and not Docker introspection:

- Docker introspection can't see native services (9router, filebrowser, cloudflared, RustDesk,
  SMB…) and can't know which published port is the "front door" worth linking.
- A curated catalog is honest about **status** (dead tunnel hostnames like `server.*`/Ollama
  stay listed with `status: "dead"` instead of silently vanishing) and about **exposure**
  (public-via-tunnel vs LAN-only) — neither is discoverable from the Docker API.
- Grouping is fixed: public first, then LAN per host (macmini → bmax → hpmini).

**MAINTENANCE RULE: the catalog is the portal's source of truth. When the homelab changes
(new service, new tunnel hostname, service retired, IP change), update
`api/src/portal/catalog.ts` in the same commit.** It covers Docker AND native services across
all 3 machines; each entry carries host/runtime/exposure/status plus public `url` and
optional `lanUrl`.

Web side uses **hash routing** (`#/portal`) — no react-router, keeping `web/` zero-dependency
per the repo's plain-forms style. nginx already had the SPA fallback so no config change was
needed. Tests: `api/tests/portal.test.ts` (grouping order, no dropped entries, dead entries
stay visible, URL shape invariants). Also on 2026-09-18: `GET /api/v1/containers` now
excludes `removed` tombstones (they stay in the DB as event history; every other read surface
already skipped them).

**Milestone 8 (Container control) — complete, 2026-09-14. Local host only, no auth yet.**

The app's first genuinely Docker-mutating write surface. Everything before this milestone was
provably read-only (`DockerReadAdapter` has no write methods anywhere); this milestone adds one
deliberate, narrow exception rather than loosening that guarantee.

- **Scope, as explicitly decided by the homelab owner**: start, stop, and restart (not the
  spec's more conservative "restart-only" suggestion) — for the **local host only**. No control
  path exists or was added for agent-reported remote hosts (BMAX) — the agent still never mounts
  `docker.sock` and has no code path that could mutate a container, unchanged from Milestone 7.
  **Auth is still not implemented** (deliberately deferred to the last milestone, a standing
  decision reconfirmed here) — this means anyone who can reach the dashboard on the LAN can
  start/stop/restart any local container right now. Documented as an accepted risk, not an
  oversight; see `docs/reverse-proxy-and-auth.md` for the interim mitigation (reverse-proxy auth
  or LAN-only) and `~/work-agent/CLAUDE.md`'s KangOps entry for the homelab-level warning.
- **A second, write-scoped `docker-socket-proxy` sidecar** (`docker-socket-proxy-control` in
  `docker-compose.yml`), not a widened version of the existing read-only one. Reason, confirmed
  by reading `tecnativa/docker-socket-proxy:0.2.0`'s actual `haproxy.cfg.template` before writing
  any code: its `CONTAINERS=1` allow-rule matches **any HTTP method** on any `/containers/*`
  path, not just GET — so turning on `POST`/`ALLOW_*` on the *same* proxy that also has
  `CONTAINERS=1` (needed for the read adapter) would silently reopen `/containers/create`,
  `/containers/{id}` (exec), prune, etc. alongside the 3 intended actions, because that broader
  allow-rule is evaluated after the narrow ones and doesn't care which method matched. The
  control proxy therefore runs with `CONTAINERS=0, INFO=0, PING=0, POST=1, ALLOW_START=1,
  ALLOW_STOP=1, ALLOW_RESTARTS=1` — confirmed live post-deploy: `POST /containers/create` and
  `GET /containers/json` against this proxy both return 403, only the 3 allowlisted
  start/stop/restart request shapes succeed. Same hardening as the read proxy (`:ro` socket
  mount, `cap_drop: ALL`, `no-new-privileges`, not `read_only` for the same haproxy-config-sed
  reason documented on that service).
- `api/src/docker/types.ts`: new `DockerControlAdapter` interface (`startContainer`/
  `stopContainer`/`restartContainer`), deliberately **not merged into** `DockerReadAdapter` — every
  existing read-path caller stays provably incapable of mutating anything, by type. Real
  implementation in `docker/dockerControlAdapter.ts` (dockerode against `DOCKER_CONTROL_HOST`,
  the control proxy above).
- **Opt-in via config**, off by default: `CONTAINER_CONTROL_ENABLED` (default `false`) +
  `DOCKER_CONTROL_HOST`. `index.ts` only constructs the real control adapter when
  `CONTAINER_CONTROL_ENABLED=true` **and** `DOCKER_MODE=socket`; otherwise `buildApp` gets
  `controlAdapter: undefined` and every control route reports `501 not_enabled` rather than
  silently no-op'ing — a misconfigured/disabled deployment is visible in the API response, not
  just an absent route. `docker-compose.yml` sets it `true` for this deployment (the owner's
  explicit choice); `.env.example` documents the no-auth risk and defaults to `false` for local/
  fixture dev.
- `api/src/routes/containerControl.ts`: `POST /api/v1/containers/:id/{start,stop,restart}`.
  Kept in its own file rather than folded into `containers.ts`'s existing `PATCH` (which only
  ever flips the local `critical` flag, never touches Docker) since this is a different trust
  boundary. Checks, in order: control enabled (else 501) → container known to this server (else
  404) → `hostId === "local"` (else 400 `unsupported_host` — agent hosts have no control path)
  → call the adapter. **Every attempt, success or failure, is audit-logged** to the existing
  `events` table (`source: "container_control"`, `type: "container_{action}"`,
  `severity: "info"|"warning"`) — no new table needed, the existing lifecycle-event log already
  had exactly the right shape (hostId, containerId, occurredAt, source, type, severity, summary).
- `web/`: `ContainerControlPanel` on the container detail view, local-host containers only.
  Every action requires a native `window.confirm()` before the request fires (per the spec's
  "control action is separately enabled and visibly confirmed" principle) — deliberately no new
  dependency/custom modal, matches the rest of `web/`'s plain-forms style. Start disabled when
  already running; stop/restart disabled when not running — a UX nicety only, the API's own
  checks are the real enforcement.
- Tests: `tests/containerControl.test.ts` (501-when-disabled, 404-unknown, 400-non-local-host,
  all 3 actions call the right adapter method and record a success audit event, adapter throw →
  502 + failure audit event). 151 tests total, up from 144.
- **Verified end-to-end against real hardware.** `docker compose build && docker compose up -d`
  on the real MACMINI Docker host — all 4 containers (`docker-socket-proxy`,
  `docker-socket-proxy-control`, `api`, `web`) healthy. Called the real API directly against a
  real (low-risk, non-production) container: `stop` → confirmed `docker ps` showed it exited,
  `start` → confirmed running again, `restart` → confirmed a fresh uptime, each followed by
  confirming the matching audit event landed in `GET /api/v1/containers/:id`. Then confirmed the
  control proxy's own allowlist boundary directly (not just through the app): `GET
  /containers/json` and `POST /containers/create` against `docker-socket-proxy-control` both
  403'd, proving the earlier haproxy-template read was correct and the narrow scope actually
  holds, not just in theory.
- **Not torn down** — same as every milestone since Milestone 6, this is a production service;
  left running with the new control surface live.

### Known gotchas (Milestone 8)

- **This milestone was dispatched to two background subagents concurrently by mistake**, and a
  third (a sub-agent one of them spawned per this file's own "delegate complex sub-parts"
  suggestion) actually started editing the same files at the same time as a human-directed
  session doing the identical work by hand. The colliding agent noticed the conflict itself
  (via changing file mtimes and a stray second `claude --print` process) and correctly stopped
  before running `docker compose up --build`, testing container actions, or committing/pushing
  — no production impact — but the repo was left with 3 different partial/conflicting
  implementations of the same milestone as uncommitted changes. Resolved by discarding all
  uncommitted work (`git checkout -- .` + removing the new untracked files; nothing was lost
  since nothing had been committed yet) and redoing the milestone as one single actor. Worth
  remembering before dispatching another background dev task while also considering doing it by
  hand in the same session.
- **`exactOptionalPropertyTypes: true` (already on in `tsconfig`) rejects `foo?: T` when a
  caller explicitly passes `undefined`** for that property — needs `foo?: T | undefined` on the
  interface, not just the `?`. Hit this wiring `BuildAppOptions.controlAdapter`, since
  `index.ts` computes `controlAdapter` as `T | undefined` and passes it through unconditionally.

**Milestone 7 (Multi-host agents) — complete, 2026-09-13. First remote host: BMAX.**

This is the milestone where "KangOps monitors the host it runs on" stops being true. It is a
narrow slice of the spec's Phase 4, taken early and deliberately: per-host push agents and
node-aware aggregation, but **no** scoped per-node credential rotation, no node-local storage,
and no auth (still deliberately deferred — see below).

- **Direction of collection is the whole design decision.** The local collector polls a socket
  proxy on its own host; that does not extend to other machines without either exposing each
  host's Docker API on the LAN or opening an inbound port per host. So the agent inverts it: it
  collects locally and makes an **outbound** POST to this server. A monitored host therefore
  opens no inbound port, exposes no socket off-host, needs no firewall/router change, and works
  behind NAT or on another subnet. The per-host token is both its auth and its identity, so
  revoking a host is deleting one row.
- `api/src/agents/`: `payload.ts` (zod validation at the boundary; every host metric nullable so
  a partially-readable host still reports the rest), `repo.ts` (CRUD + 32-byte hex token, the
  `backups/targetsRepo.ts` pattern — returned once at creation, masked on every read; the
  `hosts` row is created at *registration* time so a registered-but-undeployed agent is visible
  as `status: "unknown"` rather than invisible), `ingest.ts` (impure; **reuses
  `collector/diff.ts`** so an agent-reported container produces byte-identical rows and
  lifecycle events to a locally-polled one — the dashboard, event timeline, and health engine
  genuinely cannot tell which host a container came from), `health.ts` (pure `evaluateAgentHealth`
  + impure `gatherAgentSnapshots`).
- **Remote health runs through the same engine, not a parallel path.** `agents/health.ts` feeds
  each fresh agent's host metrics + container rows into `health/engine.ts`'s `evaluateHealth`,
  and `health/cycle.ts` merges the result into the one shared reconcile/persist/score pass
  alongside local host, container, and backup conditions — exactly how Milestone 4 folded in
  backup freshness. Consequence, confirmed live: BMAX's real 91.5% disk opened a `disk_critical`
  (penalty 30) and moved the whole homelab's score to critical/30. New code
  `agent_unreachable` (critical, penalty 20, matching the spec's "collector/node unavailable")
  fires when an agent misses 3 consecutive expected intervals. Two deliberate non-obvious
  choices: a **stale** agent's last-known metrics are *not* scored (otherwise a dead host's
  stale "CPU high" — or stale "all fine" — would sit in the attention queue forever), and a
  **never-reported** agent produces no condition at all (that's a setup state, not a regression;
  it stays visible in `GET /hosts`). The local collector cycle is also what detects staleness —
  an agent that has stopped reporting obviously can't report its own absence.
- `agent/` (new top-level dir): `agent.sh` + `Dockerfile` + `docker-compose.yml` + `.env.example`
  + `README.md`. **POSIX shell + curl + jq on alpine:3.21 (~14MB image), not Node**, because the
  first target host runs a production workload on 2 weak cores — idle cost is a sleeping busybox
  `sh` (measured 880KiB RSS, 0.00% CPU) instead of a resident language runtime. One Docker API
  call and one POST per 30s interval, nothing in between. Runs as `nobody`, `read_only: true`,
  `cap_drop: ALL`, `mem_limit: 32m`, `cpus: 0.25`. Same socket-proxy boundary as the server
  (`CONTAINERS`/`INFO`/`PING`, `POST=0`) — the agent never mounts `docker.sock` and has no code
  path that could start/stop/modify a container. Both containers cap their json-file logs at
  1MB×2, because filling a monitored host's disk with monitoring logs would be an own goal.
- API additions: `GET/POST/DELETE /api/v1/agents` and rate-limited (60/min/token)
  `POST /api/v1/agents/:token/report`. The server stamps every report's observation time itself
  rather than trusting the agent's clock, so a host with no NTP or a dead RTC can't poison the
  time series or the retention windows. `GET /api/v1/hosts` widened from bare identity fields to
  carry `kind` (local|agent) + latest CPU/memory/disk + container count + agent version, so the
  multi-host dashboard needs one call. `GET /api/v1/containers` gained `hostId` — it stopped
  being a constant now that two hosts can each run a container named `postgres`.
- Schema: added `agents` (+ migration `0004_mysterious_talon.sql`). Deleting an agent removes
  only the registration, never the `hosts`/`containers`/`metric_samples` rows it produced —
  those are real observed history (and FK'd). Migration applied cleanly against the existing
  populated production volume, which doubled as this milestone's upgrade test.
- `web/`: a Hosts panel above the attention queue (one card per host, capacity as a number +
  threshold badge per the "no decorative charts" rule, labeled local vs agent because the two
  fail differently), a "Remote agents" panel under Operations (register → token shown once,
  pending/reporting/stale per agent, delete), and a host column on the container list that only
  appears once >1 host is tracked. No new dependency.
- Tests: `tests/agentHealth.test.ts` (pure staleness/eval, incl. the stale-metrics-not-scored and
  never-reported cases), `tests/agentRoutes.test.ts` (registration, token masking, ingest,
  lifecycle events, the omitted-vs-empty `containers` distinction). 144 total, up from 118.
- **Verified end-to-end against real hardware, both directions.** Server rebuilt and left running
  on MACMINI; agent deployed to BMAX over SSH; `GET /api/v1/hosts` shows both hosts with live
  numbers, and all 5 BMAX containers (3 Immich + the 2 agent containers) appear with correct
  state/health/Compose project. Failure mode tested by stopping only the agent container: the
  server opened `agent_unreachable`, and restarting it self-healed on the next cycle.
- **Not torn down.** Unlike Milestones 1-5's build-verify-teardown pattern, both the MACMINI
  server and the BMAX agent are left running — as of Milestone 6 this is a production service,
  and an agent that only runs during a verification window monitors nothing.

### Immich safety constraints (BMAX)

BMAX runs a **production Immich stack** (`/home/wawan/immich/`, Compose project `immich`,
containers `immich_server`/`immich_postgres`/`immich_redis`, ~2 months uptime) on an Intel N4000
with 2 cores and a **97%-full 128GB disk**. That shaped several choices above and is worth
keeping in mind before touching this host again:

- The agent is its **own Compose project** (`name: kangops-agent`, in `/home/wawan/kangops-agent/`)
  with its own container names and network. `/home/wawan/immich/docker-compose.yml` was read for
  conflict-checking and **never modified**; no Immich container was restarted, stopped, or
  reconfigured at any point (verified by container ID + "Up 2 months" before and after).
- No port conflict is possible: the agent publishes nothing at all. Immich holds only 2283.
- The disk headroom (~4GB) is why the agent image is alpine-sized and why both its containers
  have capped logs. Note the disk is *legitimately* near-full, so KangOps will keep reporting
  `disk_critical` for BMAX until someone frees space — that's a true signal, not a false alarm.

### Known gotchas (Milestone 7, in addition to Milestone 4's below)

- **busybox `awk` converts to a 32-bit signed int for `%d`.** `printf "%d", total*1024` on an
  8GB `MemTotal` silently produced `-2147483648`, which the server then (correctly) rejected as
  an invalid payload — the agent's first deployment reported HTTP 400 on every cycle for exactly
  this reason. awk holds numbers as doubles, so `%.0f` prints the real value. Every byte count in
  `agent/agent.sh` uses `%.0f` for this reason; anything over 2GB would otherwise break.
- **`MemAvailable`, not `MemFree`, for an agent host.** The local collector uses Node's
  `os.freemem()` (= `MemFree`). On a Linux host up for months, nearly all spare RAM is
  reclaimable page cache, so `MemFree` reads as ~95% used and would open a permanent, meaningless
  `host_memory_high` condition. BMAX: 21.9% by `MemAvailable` vs ~92% by `MemFree`. The two
  collection paths therefore disagree slightly by design — documented in `agent.sh`.
- **busybox `df` wraps long device names onto their own line**, shifting every positional field.
  `agent/agent.sh` indexes df fields from the end (`$(NF-3)`/`$(NF-4)`) so both layouts parse.
- **Docker's `/containers/json` carries no `RestartCount`** (only `/containers/{id}/json` does),
  and its health state is only available as a suffix on the human-readable `Status` string
  (`"Up 2 months (healthy)"`). The agent parses that suffix and reports `restartCount: 0`, rather
  than paying an inspect round trip per container per tick on a weak host. Consequence: the
  `restart_loop` condition cannot fire for agent-monitored containers, and per-container
  cpu/memory stats aren't collected for them either.
- **`DOCKER_CONFIG` also controls where the Docker CLI finds its plugins.** Pointing it at a
  scratch dir to dodge a hung `docker-credential-desktop` (macOS keychain prompt, which stalls
  `docker compose build` indefinitely in a non-interactive session) makes `docker compose`
  itself vanish with "unknown command". Symlink `~/.docker/cli-plugins` into the scratch config
  dir as well.

**Milestone 6 (KangOps rebrand) — complete, 2026-09-13.**

- Pure rebranding milestone: no stack changes, no new features, no config-surface changes. The
  product is renamed KangDocker → KangOps (see the header note above for the "why" — broader
  long-term homelab-ops vision, Docker observability staying as the first module). GitHub repo
  and local folder were already renamed to `KangOps` before this milestone started; this
  milestone is the text/identity pass over the codebase itself.
- Package identity: `api/package.json` and `web/package.json` `name` → `kangops-api`/
  `kangops-web`; both `package-lock.json`s regenerated (`npm install --package-lock-only`) so
  the lockfile `name` fields match instead of drifting from `package.json`.
- Runtime/storage naming: `docker-compose.yml`'s named volume `kangdocker_data` →
  `kangops_data`, and its `api` service's `DATABASE_PATH` env override → `/data/kangops.sqlite`.
  Brought `.env`/`.env.example`, `api/src/config.ts`'s `DATABASE_PATH` default, and
  `api/drizzle.config.ts`'s fallback url in line with the same new filename — these had to move
  together since `docker-compose.yml`'s explicit `environment:` value silently overrides
  `env_file`, and a previous pass had only updated the compose file, leaving local
  (non-Compose) dev pointed at the old `kangdocker.sqlite` filename. `api/docker-entrypoint.sh`'s
  comment and the temp-dir prefixes in `api/src/test-helpers/db.ts` and `api/tests/db.test.ts`
  (`kangdocker-test-`/`kangdocker-upgrade-test-`) updated to match; `api/tests/config.test.ts`'s
  assertion updated accordingly. Compose service names (`docker-socket-proxy`/`api`/`web`) were
  already generic and untouched; **host port stays 8085**, unchanged.
- User-visible/CI text: `web/index.html` `<title>`, `web/src/App.tsx`'s `<h1>`, the webhook
  alert title prefix in `api/src/alerts/format.ts` (`[KangDocker]` → `[KangOps]`), `README.md`
  (title + the two doc-index blurbs referencing KangDocker by name), `docs/install.md`,
  `docs/backup.md`, `docs/retention.md`, `docs/reverse-proxy-and-auth.md`,
  `docs/troubleshooting.md`, and `.github/workflows/ci.yml`'s health-check step (container
  names `kangdocker-api-1`/`kangdocker-web-1` → `kangops-api-1`/`kangops-web-1`, matching the
  Compose-project-name-from-folder-name convention now that the folder is `KangOps`).
- Deliberately left untouched: this file's own historical Current State entries below (every
  "KangDocker" mention in Milestone 1-5 write-ups is factually correct for when it was written,
  per the header note) and the original spec doc's filename
  (`~/Documents/CLAUDE-KangDocker.md`, outside the repo, not renamed). No endpoint paths,
  allowlist entries, schema, or other technical identifiers were touched.
- Verified end-to-end on the real MACMINI Docker host: `docker compose up -d --build`, all 3
  containers came up named `kangops-*-1` (from the renamed project folder, no explicit
  `container_name:` needed), `curl http://localhost:8085/api/v1/summary` returned a normal
  summary against the real homelab, then `docker compose down -v` — not left running, same as
  every prior milestone. Full lint/typecheck/test re-run in both `api/` and `web/` after the
  rename to catch any stale hardcoded string.

**Milestone 5 (Harden and release) — complete, 2026-08-26. This is the project's first tagged
release, `v1.0.0`.**

- Security review: re-audited every Compose service's `cap_drop`/`cap_add`, `read_only`,
  non-root entrypoint, and `docker-socket-proxy` allowlist against this file's Docker socket
  security section and the "Security checklist" — all already consistent/minimal from prior
  milestones (Milestone 1's chown-then-drop-privileges pattern on `api`/`web`, Milestone 2's
  socket-proxy allowlist, Milestone 4's secret-masking on webhook/backup-token endpoints). No
  privilege gaps found; no Compose changes were needed. Also re-read `alerts/dispatch.ts`,
  `alerts/notifier.ts`, `backups/rateLimiter.ts`, and `routes/settings.ts` specifically for
  secret handling and confirmed no secret ever reaches a log line or API response.
- Added a Milestone-5-specific test: `api/tests/db.test.ts`'s "upgrade / re-run migrations
  against an existing populated database" suite — boots against a real file-based DB (not
  `:memory:`), writes a row, re-runs `runMigrations` twice more (simulating a container
  restart/image upgrade against the same volume, and a crash-loop re-triggering the entrypoint),
  and asserts data survives and no re-run throws. Existing coverage already exercised the other
  Milestone 5 failure modes thoroughly (`collector.test.ts`'s failing/timeout adapter cases,
  `milestone4Cycle.test.ts`'s webhook-failure-never-throws case) — those didn't need new tests,
  just re-confirmation. 118 tests total (up from 117).
- New `docs/`: `install.md`, `reverse-proxy-and-auth.md` (KangOps has no built-in auth —
  documents reverse-proxy/Cloudflare-Access/LAN-only options and what's exposed if you skip
  this), `backup.md` (SQLite `.backup`-based backup/restore of KangOps's own database —
  distinct from the Milestone 4 backup-*monitoring* feature), `retention.md` (documents the
  existing two-tier metric retention plus the deliberate non-pruning of events/health_conditions/
  alerts at homelab scale), `troubleshooting.md`. Linked from `README.md`.
- Verified end-to-end **on the real MACMINI Docker host** (`docker compose up -d --build`, all
  3 containers healthy, real ~23-container homelab visible via `/api/v1/summary`/`/containers`):
  stopped `docker-socket-proxy` to simulate Docker unavailability — confirmed `GET
  /api/v1/hosts` correctly reported the host `unreachable`, `collector_error` events were
  recorded, `/readyz` kept reporting `ok` (readiness only checks the DB, by design), and the API
  process never crashed or needed a restart; restarted the proxy and confirmed the host
  self-healed back to `reachable` on the next collector tick with no manual intervention.
  Separately restarted `api` against the already-populated volume (simulating an upgrade) and
  confirmed a clean restart with no migration errors and all prior data/conditions intact. Then
  `docker compose down -v` — not left running as a standing service, same as every prior
  milestone.
- No significant follow-up issues found during this milestone's homelab testing beyond the two
  pre-existing, already-documented ones below (events/health_conditions/alerts unbounded growth
  at scale — deliberately deferred, see `docs/retention.md`).
- Tagged `v1.0.0` and published a GitHub Release summarizing all 5 milestones.

**Milestone 4 (Notification and operational context) — complete, 2026-08-26.**

- `api/src/alerts/`: webhook alert destination. `types.ts`/`webhookConfigRepo.ts` store one
  config (`enabled`, `url`, `format: generic|discord|ntfy`, `cooldownMinutes`) as settings-table
  JSON (key `alert_webhook_config`), same pattern as `health/thresholdsRepo.ts` — `GET
  /api/v1/settings/webhook` never returns the raw url, only `maskWebhookUrl`'s
  scheme+host+`/***` (the url is effectively a bearer credential for ntfy/Discord). `format.ts`
  is a pure payload builder per destination (fixture-tested), `dispatch.ts` is the only impure
  piece (bounded `fetch` with `AbortController`, mirrors `collector/loop.ts`'s timeout pattern),
  `cooldown.ts` is a pure `shouldSendAlert` helper, and `notifier.ts` (`dispatchAlerts`) wires
  them together: called from `health/cycle.ts` with exactly the conditions `reconcile.ts` just
  decided are newly-opened this cycle (not every active condition), so "deduplication" is mostly
  free — `cooldownMinutes` additionally guards a flapping condition from re-alerting every
  resolve/reopen. Every attempt (sent or failed) is persisted to the new `alerts` table
  (denormalized entityType/entityId/code/summary, not an FK to `health_conditions`, so alert
  history reads sensibly even though conditions are never deleted). A webhook failure is
  recorded + logged, never thrown — cannot fail the collector cycle that triggered it.
- `api/src/backups/`: backup target freshness + authenticated result webhook. `backup_targets`
  (name, `expectedFrequencyMinutes`, optional `checkPath`, a 32-byte hex `token` generated once
  at creation and only ever returned in that one response) and `backup_runs` (one row per
  reported webhook result; filesystem freshness is evaluated live from mtime each cycle in
  `gather.ts`, never persisted as a row, so the table only grows on real reported events, not
  every ~20s tick). `freshness.ts`'s `evaluateBackupHealth` is a pure function (fixture-tested)
  producing the same `HealthConditionInput` shape `health/engine.ts` uses — codes
  `backup_stale` (1.5x/3x `expectedFrequencyMinutes` → warning 20/critical 35),
  `backup_missing` (never reported, first window elapsed → critical 35), `backup_failed` (most
  recent reported run was a failure → critical 35). `health/cycle.ts` merges these into the same
  conditions list as host/container conditions before one shared
  reconcile+persist+`summarizeConditions` pass — `health/engine.ts` itself stays untouched/
  host+container-only. `POST /api/v1/webhooks/backup/:token` matches the spec's exact
  `POST /webhooks/backup/{token}` shape; the token *is* the auth (no separate header scheme),
  rate-limited per token (`backups/rateLimiter.ts`, a hand-rolled in-memory fixed-window
  limiter — not a dependency, this is a few lines for one low-traffic endpoint) at 10 req/min.
- `api/src/images/`: opt-in image/update center, off by default
  (`images/registryConfigRepo.ts`'s `registry_check_config`, same settings-table pattern).
  `parseRef.ts` recognizes *only* Docker Hub image references (`nginx`, `user/repo[:tag]`) —
  anything with a host-looking first path segment (`ghcr.io/...`, `host:port/...`, `localhost/
  ...`) is reported as an unsupported registry rather than silently skipped or half-implemented;
  multi-registry auth is real scope this milestone deliberately doesn't take on.
  `dockerHubClient.ts` calls Docker Hub's public v2 API, unauthenticated, only ever invoked from
  `images/check.ts` when the opt-in flag is true, throttled per-image to once per 6h
  (`RECHECK_INTERVAL_MS`) via each row's own `lastCheckedAt` — no separate scheduler, same "cheap
  to check every collector tick" pattern as `metrics/runRetention.ts`. Cached results land in
  `image_metadata` (keyed by image ref); `GET /api/v1/images` always shows locally-observed
  image/digest facts (no network call), and only computes `updateAvailable` per-container
  (comparing the container's own observed digest to the cached `latestDigest`) when the opt-in
  flag is on.
- `api/src/dependencies/`: conservative dependency view, per this file's explicit "do not imply
  causal runtime dependencies from shared networks alone" guidance — extended to *not even use*
  shared-network data, since the read adapter never collects Docker network membership at all
  (see `docker/types.ts`). `view.ts`'s `buildDependencyView` (pure, fixture-tested) surfaces
  exactly two sources: Compose-project co-membership computed directly from
  `containers.composeProject` (label: `source: "compose_project"`, `confidence: "weak"`, an
  explicit non-causal note, only shown for projects with 2+ containers) and explicit
  `dependency_annotations` rows a user creates via `POST /api/v1/dependencies/annotations`
  (label: `source: "user_annotation"`, `confidence: "declared"` — the only source treated as an
  intentional edge). No inference beyond that.
- Schema: added `alerts`, `backup_targets`, `backup_runs`, `image_metadata`,
  `dependency_annotations` — see `api/drizzle/0003_worried_night_nurse.sql`. `alerts` is
  deliberately denormalized rather than FK'd to `health_conditions` (see above);
  `image_metadata.updateAvailable` is stored but not authoritative (recomputed per-container at
  read time) — kept only as a coarse "did the last check resolve a digest at all" signal.
- API additions (all still schema-validated, all secrets masked/never-returned per this file's
  security checklist): `GET/PUT /api/v1/settings/webhook`, `GET /api/v1/alerts` (recent delivery
  history), `GET/POST/DELETE /api/v1/backup-targets`, `POST /api/v1/webhooks/backup/:token`
  (the one genuinely new *unauthenticated-by-session* write surface — auth is the scoped token
  itself), `GET /api/v1/images`, `GET/PUT /api/v1/settings/registry`, `GET /api/v1/dependencies`,
  `POST/DELETE /api/v1/dependencies/annotations`.
- `web/`: a new "Operations" section (`App.tsx`) with 4 compact panels — webhook settings +
  recent-deliveries list, backup targets (create form that shows the token exactly once, list
  with freshness status), images/update center (registry-check opt-in toggle + per-container
  update status), and dependencies (Compose-project groups + an annotation create/delete form).
  Deliberately plain forms/lists, no new dependency, consistent with the rest of `web/`'s
  no-charting-library style.
- Tests: `tests/alertCooldown.test.ts`, `tests/alertFormat.test.ts` (pure), `tests/
  backupFreshness.test.ts` (pure), `tests/imageParseRef.test.ts` (pure),
  `tests/dependencyView.test.ts` (pure), `tests/milestone4Routes.test.ts` (all new/changed
  routes), `tests/milestone4Cycle.test.ts` (integration through the real collector loop —
  webhook dispatch incl. cooldown/failure handling, backup freshness conditions). 117 tests
  total, all passing (up from 68 at the end of Milestone 3).
- Verified end-to-end via `docker compose up -d --build` **on the real MACMINI Docker host**
  (all 3 containers healthy): created a real backup target, POSTed a result to its webhook
  endpoint and confirmed it's reflected in `GET /api/v1/backup-targets`; confirmed `GET
  /api/v1/images` shows locally-observed digests with registry checks off by default; confirmed
  `GET /api/v1/dependencies` groups the real homelab's Compose-project containers with the
  "weak" label. Then torn down (`docker compose down -v`) — not left running as a standing
  service, same as Milestones 1-3.

### Known gotchas (Milestone 4, in addition to Milestone 3's below)

- **A test asserting exact webhook-delivery call counts can flake on real host CPU/memory
  sampling.** `host/metrics.ts` samples real `os.cpus()` over a 200ms window; in a loaded CI
  sandbox this can occasionally cross the default `cpuWarningPercent`/`memoryWarningPercent`
  thresholds and open/close its own `host_cpu_high`/`host_memory_high` conditions independently
  of whatever a test is trying to exercise. `tests/milestone4Cycle.test.ts` learned this the hard
  way — assert on the specific condition `code`/`entityType` you care about, not a total
  `fetchMock` call count.
- **`drizzle-orm` 0.33's better-sqlite3 driver supports `.returning().all()`/`.get()` on
  inserts** (SQLite's own `RETURNING` clause) — used in `backups/targetsRepo.ts` and
  `dependencies/annotationsRepo.ts` to get the generated id back without a separate `SELECT`.
  Confirmed working here in case a future milestone assumes otherwise.

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

KangOps is a personal, local-first **Docker observability and control tower** for a homelab. It gives one person a calm, useful view of whether their services are healthy, why something changed, and what needs attention.

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
