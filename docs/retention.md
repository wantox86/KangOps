# Retention

KangOps keeps three kinds of history, each with different retention behavior. All of it is
enforced automatically — there's no separate retention cron/service to configure or forget to
run.

## Metric samples (host/container CPU, memory, disk)

Two-tier, per `api/src/metrics/retention.ts`:

- **Raw samples** (`metric_samples`, one row per host/container per collector tick): kept
  **24 hours**, then folded into hourly rollups and deleted.
- **Hourly rollups** (`metric_samples_hourly`, avg/max CPU, avg/max memory, last-known disk):
  kept **30 days**, then deleted outright (no further downsampling tier — a two-tier scheme is
  enough at single-homelab-host scale, per this project's "avoid overengineering" principle).

This runs every collector tick (`api/src/metrics/runRetention.ts`, called from
`api/src/collector/loop.ts`) — cheap at homelab scale, no separate scheduler needed. Chart
queries (`GET /api/v1/containers/:id/metrics`, `GET /api/v1/hosts/:id/metrics`) automatically
use raw resolution for ranges ≤24h and hourly rollups beyond that.

These defaults aren't currently user-configurable through the API/UI (only health thresholds
are) — changing them means editing `DEFAULT_RETENTION_CONFIG` in
`api/src/metrics/retention.ts` and redeploying.

## Events (lifecycle timeline)

**Not currently pruned.** `events` rows (container discovered/state-changed/health-changed/
restarted/removed, collector errors) are append-only. At homelab scale (a modest number of
containers, one row per meaningful state transition — not per collector tick) this grows slowly
enough that it wasn't judged worth building a retention job for in this release. If your event
table becomes large enough to matter (very high container churn, very long uptime), that's a
known follow-up — see `CLAUDE.md`'s Current State / known issues.

## Health conditions and alerts

**Not pruned either**, and deliberately so: `health_conditions` keeps resolved rows
(`active=false`, `resolvedAt` set) rather than deleting them, and `alerts` keeps every delivery
attempt (sent or failed) — both are meant to stay queryable as an audit trail
(`GET /api/v1/attention`, `GET /api/v1/alerts`), not just current state. Same "not currently a
problem at homelab scale" reasoning as events above.

## Backup-target freshness

`backup_runs` only grows when a backup job actually reports a result via its webhook — not on
every collector tick (filesystem freshness is evaluated live from mtime each cycle and never
persisted as its own row) — so this table's growth is bounded by how often your own backup jobs
run, not by KangOps's polling interval.

## If disk usage becomes a concern

Check volume size with `docker system df -v` or `du -sh` on the named volume's host path. The
biggest lever by far is metric retention (raw samples are the highest-volume table) — lowering
`rawRetentionMs`/`hourlyRetentionMs` in `api/src/metrics/retention.ts` (or increasing
`COLLECTOR_INTERVAL_MS` in `.env` to sample less often) has the most effect for the least risk.
