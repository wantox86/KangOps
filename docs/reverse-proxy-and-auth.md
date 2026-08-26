# Reverse proxy and authentication

**KangDocker has no built-in authentication.** Every `/api/v1/*` route is reachable by anyone
who can reach the `web` container's published port. This is an explicit MVP exclusion (see
`CLAUDE.md`'s "Non-goals" / "Explicit MVP exclusions" — "Authentication beyond an intentional
deployment recommendation (reverse proxy auth or local trusted network)"), not an oversight.

Treat exposing KangDocker like exposing any other unauthenticated homelab dashboard: fine on a
trusted LAN, **not fine directly on the internet**.

## What's exposed if you skip this

- Read access to everything: container list/detail, health scores, metrics history, events,
  alert delivery history, dependency view.
- One functional write surface: `PATCH /api/v1/containers/:id` (critical-flag toggle only —
  never touches Docker) and `PUT /api/v1/settings*` (thresholds, webhook config, registry-check
  opt-in). None of these can start/stop/recreate a container or reach the Docker socket — see
  `README.md`'s "Docker socket security" section — but an unauthenticated visitor could still
  silence your alerting by disabling the webhook, or flip which containers count as critical.
- The backup-result webhook (`POST /api/v1/webhooks/backup/:token`) is the one endpoint that's
  *designed* to be called without a session — its own high-entropy per-target token is the auth
  for that one endpoint specifically, unrelated to the rest of the API being open.

## Recommended: reverse proxy with auth in front

Put KangDocker's `web` container behind a reverse proxy that terminates TLS and requires auth
before forwarding to it — this is the pattern this project's own homelab uses for other
unauthenticated dashboards. Two straightforward options:

### Option A — Caddy with `basicauth`

```
kangdocker.example.internal {
    basicauth {
        <user> <bcrypt-hash>
    }
    reverse_proxy localhost:8085
}
```

Generate the hash with `caddy hash-password`.

### Option B — Cloudflare Tunnel + Cloudflare Access

If you already expose other homelab services through a Cloudflare Tunnel (`cloudflared`), add a
hostname entry pointing at `localhost:8085` and put it behind a Cloudflare Access application
(email OTP or identity provider) rather than leaving it as an open tunnel hostname. Don't reuse
a tunnel hostname pattern that has no Access policy attached — that's equivalent to no auth at
all, just with TLS.

### Option C — Local network only

Simplest and lowest-effort: don't expose `WEB_PORT` beyond your LAN/VPN at all (no port
forward, no tunnel entry). Nothing further to configure. This is the right default if you don't
need to check KangDocker away from home.

## What NOT to do

- Don't publish `web`'s port directly to the internet (port-forward or a tunnel hostname) with
  no auth layer in front, "just for now" — this is the one mistake this doc exists to prevent.
- Don't try to add auth by patching the API itself as a quick fix — that's a real feature with
  session/credential-storage tradeoffs, out of scope for this release; a reverse proxy is the
  supported path.
