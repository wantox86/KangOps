# KangOps agent

A ~150-line shell agent that lets KangOps monitor a host it does not run on.

## Why it pushes instead of being polled

KangOps' local collector polls a Docker socket proxy on its own host. That model does not extend
to other machines without either exposing each host's Docker API on the LAN or opening an inbound
port per host. This agent inverts the direction: it collects locally and makes an **outbound**
HTTP POST to the KangOps server every interval.

Consequences, which are the point:

- No monitored host opens an inbound port, and none needs a firewall or router change.
- No Docker socket is ever reachable from off-host.
- A host behind NAT, on wifi, or on a different subnet works with no extra plumbing.
- The credential is per-host and scoped to one endpoint. Revoking a host is deleting its agent.

## What it collects

| | |
|---|---|
| Host CPU | `/proc/stat`, averaged across the whole reporting interval |
| Host memory | `/proc/meminfo` — `MemTotal` and `MemAvailable` |
| Host disk | `df -k` on a read-only bind mount of `/` |
| Uptime / kernel | `/proc/uptime`, `uname -r` |
| Containers | one `GET /containers/json` through a read-only socket proxy: name, image, digest, state, health, Compose project/service |

Everything is a read. There is no code path in the agent that can start, stop, or modify a
container, and the socket proxy in front of it runs with `POST=0` so one could not be added by
accident.

### Deliberate gaps

- **No per-container CPU/memory.** That needs a stats call per container per interval, which is
  by far the most expensive thing the agent could do. Host-level CPU/memory answers "is this box
  struggling"; the trade is documented in `api/src/agents/health.ts`.
- **No restart counts.** `RestartCount` only exists on `/containers/{id}/json`, i.e. one extra
  round trip per container per interval. Consequence: the `restart_loop` health condition cannot
  fire for agent-monitored containers. State and health transitions work normally.

## Footprint

Alpine + curl + jq, ~14MB of image, running as `nobody` with a read-only root filesystem, all
capabilities dropped, `mem_limit: 32m` and `cpus: 0.25`. Between reports the process is asleep.
Both containers cap their json-file logs at 1MB × 2, because filling a monitored host's disk with
monitoring logs would be an own goal.

## Install

On the KangOps server, register the host and copy the token (it is shown exactly once):

```bash
curl -sX POST http://localhost:8085/api/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"BMAX","hostId":"bmax","expectedIntervalSeconds":30}'
```

On the host to be monitored:

```bash
mkdir -p ~/kangops-agent && cd ~/kangops-agent
# copy agent.sh, Dockerfile, docker-compose.yml here
cp .env.example .env && chmod 600 .env   # then fill in KANGOPS_URL + KANGOPS_AGENT_TOKEN
docker compose up -d --build
```

This is its own Compose project (`kangops-agent`) with its own container names. It does not
share a network, volume, or compose file with anything already on the host, and can be stopped
or removed without touching existing services.

Verify from the server:

```bash
curl -s http://localhost:8085/api/v1/agents | jq   # status should go pending -> reporting
curl -s http://localhost:8085/api/v1/hosts  | jq   # the host appears with live CPU/mem/disk
```

## Operating notes

- The server timestamps every report itself and ignores the agent's clock, so a host with no NTP
  or a dead RTC cannot poison the time series.
- Reports are rate-limited per token (60/min). The default 30s interval uses 2.
- An agent that stops reporting for 3 intervals opens an `agent_unreachable` condition on the
  server: it shows up in the attention queue and costs 20 health points, the same as the local
  collector going down. A stale agent's last-known metrics are deliberately *not* scored.
- `docker compose logs agent` is quiet on success and logs one line per failed report. The token
  is never logged, including in curl's own error output.
