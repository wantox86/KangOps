# Install

KangOps is one Docker Compose stack: `docker-socket-proxy` (read-only Docker access),
`api`, and `web`. There is no separate database server or message queue to install — SQLite
lives on a named volume next to the API.

## Requirements

- A Docker host running Docker Engine + Compose v2 (`docker compose`, not the old
  `docker-compose` v1 binary).
- Enough free disk for the SQLite database (small — homelab-scale metric retention defaults to
  24h raw / 30 days hourly, see [`retention.md`](./retention.md)) and the two built images.
- No GPU, no external database, no message broker.

## Steps

```bash
git clone https://github.com/wantox86/KangOps.git
cd KangOps
cp .env.example .env
docker compose up -d --build
```

Wait for both containers to report healthy (`docker compose ps`), then open
`http://<host>:8085` (or whatever `WEB_PORT` you set in `.env`).

Verify the API directly (through the web container's same-origin proxy — `api` itself has no
published host port):

```bash
curl -sf http://localhost:8085/api/v1/summary
```

## What `.env` controls

`.env.example` is deliberately small. Everything in it is either a boot-time setting (port,
database path, log level, collector interval/timeout) or a Docker-access mode flag. **User-
editable settings that don't require a redeploy — health thresholds, webhook alert config,
backup targets, registry-check opt-in — are configured at runtime through the API/UI**, not
environment variables, and are stored in the `settings` table / their own tables. See
`CLAUDE.md`'s Milestone 3/4 notes if you need the exact endpoints.

Don't hand-edit `DOCKER_MODE=fixture` → `socket` for a real deployment yourself —
`docker-compose.yml` already overrides `DOCKER_MODE`/`DOCKER_HOST` for the `api` service to
point at `docker-socket-proxy`. `DOCKER_MODE=fixture` in `.env.example` is only the default for
running `api` standalone (`npm run dev`) without Docker access at all.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Migrations run automatically and synchronously before the API starts serving `/readyz` as ready
(see `api/src/index.ts` / `api/src/db/migrate.ts`) — there is no separate manual migration step,
and re-running them against an already-migrated database is a safe no-op (verified in
`api/tests/db.test.ts`'s "upgrade / re-run migrations" suite). Your data lives in the
`kangops_data` named volume and is untouched by rebuilding the images. If you want a rollback
path, see the note at the bottom of this file.

## Uninstall / full teardown

```bash
docker compose down        # keeps the kangops_data volume
docker compose down -v     # also deletes the volume (all data — hosts, history, settings)
```

## Rollback plan (if an upgrade misbehaves)

1. `docker compose down` (containers only, keep the volume).
2. `git checkout <previous-tag-or-commit>`.
3. `docker compose up -d --build`.

This only works safely backwards across versions that didn't add a schema migration the older
code doesn't understand — for a genuinely broken upgrade, restoring a SQLite file backup taken
before the upgrade (see [`backup.md`](./backup.md)) is the reliable fallback.
