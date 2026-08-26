# KangDocker

Local-first Docker observability and control tower for a homelab. Not a Portainer clone —
prioritizes understanding ("is my homelab healthy, and why") over full Docker administration.

**Status: Milestone 2 (Read-only collection and visibility) complete.** The API now collects
real container facts on a bounded interval and persists them; the dashboard shows real counts
and a container list/detail. Health scoring/history/alerting are still ahead (Milestone 3+).

See [`CLAUDE.md`](./CLAUDE.md) for the full product spec, architecture, and roadmap.

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

KangDocker's collector needs to read container facts from the Docker Engine API. That is
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
- [ ] Settings/API auth — still out of scope until a later milestone (no write endpoints exist
      yet either).

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
