# Backup

Two separate things are called "backup" in this project — don't conflate them:

1. **Backing up KangDocker's own data** (its SQLite database) — covered below.
2. **KangDocker monitoring your other services' backups** (the `backup_targets` /
   `backup_runs` feature from Milestone 4) — see `CLAUDE.md`'s Milestone 4 "Current State"
   notes and [`README.md`](../README.md) for how that feature works; this doc is only about
   #1.

## Backing up KangDocker's own database

All of KangDocker's state (hosts, containers, events, metric history, health conditions,
alerts, backup targets, image metadata, dependency annotations, settings — including the
webhook config) lives in one SQLite file inside the `kangdocker_data` named volume, at
`/data/kangdocker.sqlite` (plus WAL/SHM sidecar files while the container is running). There is
nothing else to back up — no separate config directory holds secrets or state.

### Safe way: `docker compose exec` (container running)

SQLite's `.backup` command is safe to run against a live WAL-mode database (unlike `cp`, which
can copy a torn/inconsistent file mid-write):

```bash
docker compose exec api sqlite3 /data/kangdocker.sqlite ".backup /data/backup-$(date +%F).sqlite"
docker cp $(docker compose ps -q api):/data/backup-$(date +%F).sqlite ./
```

`sqlite3` isn't installed in the runtime image by default — if `exec` fails with
"command not found", either add it temporarily (`docker compose exec api sh` then check),
or use the stopped-container approach below instead.

### Simpler way: stop, copy, start

```bash
docker compose stop api
docker run --rm -v kangdocker_kangdocker_data:/data -v "$PWD":/backup alpine \
  cp /data/kangdocker.sqlite /backup/kangdocker-backup-$(date +%F).sqlite
docker compose start api
```

(Volume name may differ — check `docker volume ls | grep kangdocker`; Compose prefixes it with
the project/directory name.) This is a short outage (however long the copy takes — the file is
small at homelab scale) but avoids any live-write-during-copy risk entirely.

### What NOT to do

- Don't `cp`/`rsync` the `.sqlite` file while `api` is running without using `.backup` — WAL
  mode means the main file alone can be missing recently-committed data still sitting in the
  `-wal` file, or mid-write and inconsistent.
- Don't back up `.env` into anything shared/public — it doesn't currently hold secrets (see
  `.env.example`'s comment: alert/backup/registry config is runtime, not env-based), but treat
  it as deployment-specific config, not something to publish.

## Restore

```bash
docker compose down
docker run --rm -v kangdocker_kangdocker_data:/data -v "$PWD":/backup alpine \
  cp /backup/kangdocker-backup-2026-08-20.sqlite /data/kangdocker.sqlite
docker compose up -d
```

Migrations run automatically on startup and are safe to re-run against a restored older backup
that predates a later migration (see [`install.md`](./install.md)'s upgrade notes) — restoring
an older backup is expected to "catch up" schema-wise on next boot, not fail.

## How often

There's no built-in scheduled backup of KangDocker's own database (that would be its own
feature, out of scope here — this doc just tells you how to do it manually or via your own
cron/systemd timer). Given the data is observational/derived (re-collected from Docker within
one cycle after a fresh start, except for user-entered config: critical flags, thresholds,
webhook config, backup targets, dependency annotations), losing it entirely is an inconvenience,
not a disaster — back it up as often as that config changes meaningfully, not necessarily daily.
