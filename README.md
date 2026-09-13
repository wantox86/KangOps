# KangOps

Local-first Docker observability and control tower for a homelab. Not a Portainer clone —
prioritizes understanding ("is my homelab healthy, and why") over full Docker administration.

**Status: Milestone 7 (Multi-host agents) complete.** KangOps monitors its own host plus any
number of remote hosts, each running the small push agent in [`agent/`](./agent/README.md) — see
that README for why the agent dials out instead of being polled. Earlier milestones:

**Milestone 4 (Notification and operational context).** The API collects real
container facts, scores health/history (Milestone 3), and now also sends webhook alerts on new
attention/critical conditions, checks configured backup targets for freshness (filesystem mtime
and/or an authenticated result webhook), optionally checks Docker Hub for newer image digests
(opt-in, off by default), and shows a conservative dependency view (Compose-project grouping
labeled "weak", plus explicit user annotations labeled "declared"). See `CLAUDE.md`'s "Current
State" for full details.

See [`CLAUDE.md`](./CLAUDE.md) for the full product spec, architecture, and roadmap.

## Documentation

- [`docs/install.md`](./docs/install.md) — install and upgrade
- [`agent/README.md`](./agent/README.md) — monitoring a second host: what the push agent
  collects, what it deliberately doesn't, and how to deploy it
- [`docs/reverse-proxy-and-auth.md`](./docs/reverse-proxy-and-auth.md) — KangOps has no
  built-in auth; how to expose it safely
- [`docs/backup.md`](./docs/backup.md) — backing up/restoring KangOps's own database
- [`docs/retention.md`](./docs/retention.md) — what history is kept, for how long, and why
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — common failure modes and what's
  expected vs. a real bug

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22 + TypeScript (strict) + Fastify |
| Web | React + Vite + TypeScript |
| Storage | SQLite (`better-sqlite3` + Drizzle ORM), WAL mode |
| Docker access | `dockerode`, read-only, via `docker-socket-proxy` (never a raw socket mount) |
| Deployment | Docker Compose, three services (`docker-socket-proxy`, `api`, `web`) |

## Local development

```bash
cp .env.example .env

cd api && npm install && npm run dev    # http://localhost:3001
cd web && npm install && npm run dev    # http://localhost:5173 (proxies /api to :3001)
```

## Running via Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:8085/api/v1/summary
```

Web UI: `http://localhost:8085` (port 8085 by default, not 8080 — see `docker-compose.yml`'s
comment on why). Override with `WEB_PORT` in `.env`.

## Docker socket security

KangOps's collector needs to read container facts from the Docker Engine API. That is
treated as the highest-risk integration in this project (Docker socket access is effectively
root on the host), so:

- **`api` never mounts `/var/run/docker.sock`.** The only service that touches the real socket
  is `docker-socket-proxy` ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)),
  which mounts it `:ro` and exposes an **allowlisted** subset of the Docker API over plain HTTP
  on the compose-internal network only (no published port). `api` talks to that proxy via
  `DOCKER_HOST=tcp://docker-socket-proxy:2375`.
- **Mounting `docker.sock:ro` directly would not be read-only at the API level.** The `:ro` flag
  only stops writes to the socket *file*; anyone who can reach the socket can still call any
  Docker Engine API route, including container create/exec/remove. The socket-proxy's allowlist
  (`CONTAINERS=1`, `INFO=1`, `PING=1`, everything else off — see `docker-compose.yml`) is what
  actually enforces read-only.
- **Direct-socket deployment (not recommended) — if you must:** mount `/var/run/docker.sock:/var/run/docker.sock:ro`
  into `api` and set `DOCKER_HOST=unix:///var/run/docker.sock` instead of using the proxy. Doing
  this hands the `api` process full Docker API access (equivalent to root on the host) even
  though the app code itself only issues read calls — there is no enforcement boundary left.
  Only do this if you understand and accept that risk; the socket-proxy path above is the
  supported default.
- `api` still runs as a non-root user, `cap_drop: ALL`, `read_only: true` root filesystem, and
  `no-new-privileges` regardless of which Docker access mode is used.
- The web UI never talks to Docker directly and never receives raw `inspect` payloads — every
  API response is the app's own normalized shape (see `api/src/docker/types.ts`).

### Milestone 2 security checklist

- [x] Docker socket access is read-only/allowlisted (`docker-socket-proxy`) and absent from the
      `api`/`web` containers.
- [x] No secrets are introduced by this milestone (no new credentials/tokens).
- [x] Inputs are schema-validated (Fastify response schemas); container/event queries are
      parameterized via Drizzle, not string-built SQL.
- [x] Collector failures are bounded (per-call timeout + limited retries) and recorded as
      visible `collector_error` events, not silent infinite retries — see
      `api/src/collector/loop.ts` and its tests.
- [x] Raw Docker `inspect`/`stats` payloads are never returned by the API; only the normalized
      `NormalizedContainer`/container-row shape is exposed.
- [ ] Settings/API auth — still out of scope until a later milestone.

### Milestone 4 additions

- [x] Webhook URL is never returned by `GET /api/v1/settings/webhook` — only a masked
      scheme+host (`alerts/webhookConfigRepo.ts`'s `maskWebhookUrl`).
- [x] Backup-result webhook (`POST /api/v1/webhooks/backup/:token`) uses a high-entropy
      (32-byte) per-target token as its only auth, is rate-limited per token
      (`backups/rateLimiter.ts`), and the token is only ever returned once, at target-creation
      time — `GET /api/v1/backup-targets` always masks it.
- [x] Registry/image checks are opt-in (`registry_check_config`, default `false`) and only ever
      call Docker Hub's public, unauthenticated API for images it can positively parse as a
      Docker Hub reference — never an implicit/default-on network call.
- [x] Dependency view never infers edges from shared networks (not even collected) — only
      Compose-project co-membership (explicitly labeled non-causal) and explicit user
      annotations.

### Milestone 7 additions

- [x] A monitored remote host opens **no inbound port** and exposes no Docker socket off-host —
      the agent only makes outbound POSTs (`agent/README.md`).
- [x] On the monitored host, the same socket-proxy boundary applies as on the server: the agent
      never mounts `docker.sock`, and the proxy in front of it allowlists `CONTAINERS`/`INFO`/
      `PING` with `POST=0`, so no write/control call can traverse it. The agent itself runs as
      `nobody` with a read-only root filesystem and all capabilities dropped.
- [x] `POST /api/v1/agents/:token/report` uses a high-entropy (32-byte) per-agent token as its
      only auth, is rate-limited per token, and validates the whole payload with zod at the
      boundary. The token is returned once at registration; every read masks it.
- [x] The agent never logs its token (including via curl's own error output, which embeds the
      effective URL — hence `-s` rather than `-sS`).
- [x] The server timestamps reports itself rather than trusting a remote clock, so a host with
      no NTP can't poison the time series or the retention windows.
- [ ] Settings/API auth — still deliberately out of scope, now also covering the agent
      registration endpoints. `POST /api/v1/agents` is as protected as `/settings` is, i.e. by
      whatever fronts the dashboard (see `docs/reverse-proxy-and-auth.md`).

## Checks

```bash
# from api/ or web/
npm run lint
npm run typecheck
npm test      # api only for now; web has no test suite yet (no logic to test there)
npm run build
```

## License

MIT.
