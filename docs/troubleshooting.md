# Troubleshooting

## Containers won't go healthy

```bash
docker compose logs api
docker compose logs web
docker compose ps
```

- `api` healthcheck hits its own `/healthz` (liveness only — never depends on the database or
  Docker). If `api` never goes healthy, check for a migration failure or port conflict in its
  logs, not a Docker-connectivity problem.
- `web`'s healthcheck hits nginx directly and doesn't depend on `api` being reachable, but
  `web`'s `depends_on: api: condition: service_healthy` means Compose won't even start `web`
  until `api` reports healthy — if `web` never starts, look at `api` first.

## The dashboard shows no containers / stale data

Most likely `docker-socket-proxy` is unreachable from `api`, or the socket proxy itself can't
reach `docker.sock`. This is a **graceful-degradation scenario by design, not a crash**:

- `GET /api/v1/hosts` will show the host `status: "unreachable"`.
- A `collector_error` event is recorded (`GET /api/v1/events`) instead of failing silently.
- `/readyz` still reports `ok` — readiness only checks the database, deliberately, since a
  temporarily-unreachable Docker daemon shouldn't make an orchestrator kill and restart an
  otherwise-fine API process (you'd lose the very error event explaining what's wrong).
- The API keeps retrying on its normal collector interval (`COLLECTOR_INTERVAL_MS`) — no
  restart needed once Docker/the proxy comes back.

To confirm this is what's happening:

```bash
docker compose logs docker-socket-proxy
docker compose ps docker-socket-proxy   # is it even running?
docker compose restart docker-socket-proxy
```

This exact scenario (socket-proxy stopped while `api` keeps running) was verified manually as
part of Milestone 5 — see `CLAUDE.md`'s Current State entry for what was observed.

## Webhook alerts aren't arriving

1. `GET /api/v1/settings/webhook` — confirm `enabled: true` and the masked URL looks right
   (the real URL is never returned by this endpoint by design — see
   [`reverse-proxy-and-auth.md`](./reverse-proxy-and-auth.md) if you're unsure why).
2. `GET /api/v1/alerts` — every delivery attempt is recorded here, sent or failed, with an
   `error` message on failure (network error, non-2xx response, timeout). A webhook failure
   never crashes the collector cycle that triggered it — it's always visible here instead of
   silently dropped.
3. Remember `cooldownMinutes` suppresses re-sending for the *same still-open* condition — if you
   expected a second alert for something that never actually resolved and reopened, that's
   working as intended, not a bug.
4. A destination endpoint that's temporarily down (DNS failure, connection refused, 5xx) will
   show up as a `status: "failed"` row with the underlying error message — check that message
   before assuming KangOps is broken.

## Backup target shows stale/missing when I know the job ran

- `backup_stale`/`backup_missing`/`backup_failed` are computed from either filesystem mtime
  (`checkPath`, if configured) or the most recent `POST /api/v1/webhooks/backup/:token` result —
  confirm your backup job is actually calling the webhook with the *current* token (tokens are
  shown exactly once, at target-creation time, and never re-displayed — if you lost it, delete
  and recreate the target).
- The webhook endpoint is rate-limited (10 req/min per token) — a backup job retry-looping on a
  wrong token/URL can hit this; check for `429` responses in your backup job's own logs.

## Upgrade / restart lost my data

It shouldn't — data lives in the `kangops_data` named volume, independent of the container
images. Check you didn't run `docker compose down -v` (the `-v` deletes volumes) instead of
plain `docker compose down`. See [`backup.md`](./backup.md) for how to check/restore from a
backup, and [`install.md`](./install.md) for the supported upgrade path.

## Migration fails on startup

The API is designed to fail loudly here rather than start in a half-migrated state — `api`'s
container will stay unhealthy/exit rather than silently serving inconsistent data (see
`api/src/index.ts`'s comment on why migrations run synchronously before `/readyz` can report
ready). Check `docker compose logs api` for the migration error itself. If this happens on a
database that was working fine before an upgrade, restore the pre-upgrade backup
([`backup.md`](./backup.md)) and report it — a migration that fails against a previously-valid
database is a bug, not expected behavior (re-running an already-applied migration is expected to
be a safe no-op — see `api/tests/db.test.ts`'s "upgrade / re-run migrations" test).

## "Unable to open database file" / permission errors

This project has hit this exact class of bug before (fresh named volumes are root-owned; see
`CLAUDE.md`'s Milestone 1 "Known gotchas"). If you're running a customized/forked Compose file
and removed the `cap_add: [CHOWN, SETUID, SETGID]` + entrypoint chown step for `api`, that's
almost certainly why. Don't work around it by running the container as root instead — restore
the entrypoint's chown-then-drop-privileges pattern.
