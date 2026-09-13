#!/bin/sh
# KangOps remote host agent (Milestone 7).
#
# Why a shell script and not a Node process: the first target host is an Intel N4000 with 8GB of
# RAM running a production Immich stack, and the agent has to be the least interesting thing on
# that box. This is ~10 shell/awk/jq invocations every AGENT_INTERVAL_SECONDS and nothing at all
# in between -- idle RSS is a few hundred KB of busybox sh, versus tens of MB for a Node runtime
# that would sit resident forever. The whole agent is 5 reads and 1 POST; it does not deserve a
# language runtime.
#
# Direction of travel is deliberate: this process only ever makes OUTBOUND requests to the
# KangOps server. The monitored host opens no inbound port, publishes no Docker socket to the
# LAN, and needs no firewall change. The scoped token below is what authenticates it.
#
# Everything it reads is read-only: /host/proc, a df on a read-only bind mount, and allowlisted
# GETs against a read-only Docker socket proxy. There is no code path here that can start, stop,
# or modify a container.
set -eu

AGENT_VERSION="1.0.0"

INTERVAL="${AGENT_INTERVAL_SECONDS:-30}"
PROC="${HOST_PROC:-/host/proc}"
DISK_PATH="${HOST_DISK_PATH:-/host/root}"
DOCKER_API="${DOCKER_API:-http://docker-socket-proxy:2375}"
# Pinned rather than negotiated: any Engine API from 1.24 up serves these two read endpoints
# identically, and a fixed version means a daemon upgrade can't silently change the payload shape.
DOCKER_API_VERSION="v1.43"
TIMEOUT="${AGENT_HTTP_TIMEOUT_SECONDS:-10}"

if [ -z "${KANGOPS_URL:-}" ] || [ -z "${KANGOPS_AGENT_TOKEN:-}" ]; then
  echo "agent: KANGOPS_URL and KANGOPS_AGENT_TOKEN are required" >&2
  exit 1
fi

# The report URL embeds the token, so it is never logged -- only the base URL ever is. Same rule
# as the server's: a credential must not end up in a log line.
REPORT_URL="${KANGOPS_URL%/}/api/v1/agents/${KANGOPS_AGENT_TOKEN}/report"

log() {
  printf '%s agent: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# "total idle" in jiffies, summed across all CPUs. idle counts both idle and iowait, matching the
# server's own host/metrics.ts.
read_cpu_counters() {
  awk '$1=="cpu" { idle=$5+$6; total=0; for (i=2;i<=NF;i++) total+=$i; print total, idle; exit }' "$PROC/stat" 2>/dev/null || true
}

# MemAvailable, NOT MemFree. This diverges from the local collector's os.freemem() on purpose:
# a Linux host that has been up for months puts almost everything spare into reclaimable page
# cache, so MemFree reads as ~95% "used" and would open a permanent, meaningless
# host_memory_high condition. MemAvailable is the kernel's own estimate of what a new workload
# could actually get, which is the question the dashboard is asking.
read_memory() {
  awk '
    /^MemTotal:/ { total=$2 }
    /^MemAvailable:/ { avail=$2 }
    END { if (total == "" || avail == "") exit 1; printf "%d %d\n", total*1024, (total-avail)*1024 }
  ' "$PROC/meminfo" 2>/dev/null || true
}

# Field offsets are counted from the end of the line, because busybox df wraps a long device name
# onto its own line and shifts every positional field by one when it does.
# used=$(NF-3), total=$(NF-4) matches statfs blocks/bfree semantics, i.e. the same numbers the
# server's local host metrics report.
read_disk() {
  df -k "$DISK_PATH" 2>/dev/null | awk 'NR>1 { u=$(NF-3); t=$(NF-4) } END { if (t == "" || t+0 <= 0) exit 1; printf "%d %d\n", u*1024, t*1024 }' || true
}

read_uptime() {
  awk '{ printf "%d\n", $1; exit }' "$PROC/uptime" 2>/dev/null || true
}

# One Docker API call per cycle, list only. Deliberately NOT one inspect per container: inspect
# is where RestartCount lives, but paying N extra round trips every interval on a weak host to
# populate a single field the server treats as optional is the wrong trade. Per-container
# cpu/memory stats are skipped for the same reason -- that endpoint is the expensive one.
collect_containers() {
  curl -s --max-time "$TIMEOUT" "${DOCKER_API}/${DOCKER_API_VERSION}/containers/json?all=1" 2>/dev/null | jq -c '
    [ .[] | {
        dockerId: .Id,
        name: ((.Names // []) | if length > 0 then (.[0] | sub("^/"; "")) else "unknown" end),
        image: (.Image // "unknown"),
        # /containers/json exposes the local image ID here, which is the same value the server
        # stores from inspect.Image locally -- so both collection paths agree on what a digest is.
        imageDigest: (.ImageID // null),
        state: (if (.State // "") | IN("running","exited","paused","restarting","created","dead") then .State else "unknown" end),
        # Health is only available as a suffix on the human-readable Status string from the list
        # endpoint ("Up 2 months (healthy)"); the structured State.Health field needs an inspect.
        health: (
          (.Status // "") as $s
          | if $s | test("\\(unhealthy\\)") then "unhealthy"
            elif $s | test("\\(healthy\\)") then "healthy"
            elif $s | test("health: starting") then "starting"
            else "none" end
        ),
        composeProject: ((.Labels // {})["com.docker.compose.project"] // null),
        composeService: ((.Labels // {})["com.docker.compose.service"] // null)
      } ]' 2>/dev/null || true
}

# Prime the CPU counters with a short sample so the very first report carries a real number
# instead of null. Every later cycle measures across the whole sleep interval, which costs
# nothing extra and is a smoother average than a 200ms window.
prev_counters="$(read_cpu_counters)"
if [ -n "$prev_counters" ]; then
  sleep 1
fi

log "starting (version ${AGENT_VERSION}, interval ${INTERVAL}s, server ${KANGOPS_URL%/})"

while :; do
  cpu_percent="null"
  counters="$(read_cpu_counters)"
  if [ -n "$counters" ] && [ -n "$prev_counters" ]; then
    cpu_percent="$(
      awk -v prev="$prev_counters" -v cur="$counters" 'BEGIN {
        split(prev, p, " "); split(cur, c, " ");
        dt = c[1] - p[1]; di = c[2] - p[2];
        if (dt <= 0) { print "null" }
        else { v = (1 - di/dt) * 100; if (v < 0) v = 0; if (v > 100) v = 100; printf "%.2f", v }
      }'
    )"
  fi
  [ -n "$counters" ] && prev_counters="$counters"

  memory="$(read_memory)"
  memory_total="null"
  memory_used="null"
  if [ -n "$memory" ]; then
    memory_total="${memory% *}"
    memory_used="${memory#* }"
  fi

  disk="$(read_disk)"
  disk_used="null"
  disk_total="null"
  if [ -n "$disk" ]; then
    disk_used="${disk% *}"
    disk_total="${disk#* }"
  fi

  uptime_seconds="$(read_uptime)"
  [ -n "$uptime_seconds" ] || uptime_seconds="null"

  containers="$(collect_containers)"

  payload="$(
    printf '{"agentVersion":"%s","hostname":"%s","kernel":"%s","uptimeSeconds":%s,"host":{"cpuPercent":%s,"memoryUsedBytes":%s,"memoryTotalBytes":%s,"diskUsedBytes":%s,"diskTotalBytes":%s}' \
      "$AGENT_VERSION" "${AGENT_HOSTNAME:-$(hostname)}" "$(uname -r)" "$uptime_seconds" \
      "$cpu_percent" "$memory_used" "$memory_total" "$disk_used" "$disk_total"
    # Omit the key entirely when the Docker query failed: to the server that means "no Docker
    # visibility this cycle, leave what you know alone", whereas an empty array would be a
    # positive claim that this host runs zero containers and would mark them all removed.
    if [ -n "$containers" ]; then
      printf ',"containers":%s' "$containers"
    fi
    printf '}'
  )"

  # -s, not -sS: curl's own error text includes the effective URL, which carries the token.
  status="$(
    printf '%s' "$payload" | curl -s -o /dev/null -w '%{http_code}' \
      --max-time "$TIMEOUT" \
      -X POST \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$REPORT_URL" 2>/dev/null || printf '000'
  )"

  case "$status" in
    202)
      : # Quiet on success -- this loop runs every 30s forever on a host with 4GB of free disk.
      ;;
    000)
      log "report failed: could not reach ${KANGOPS_URL%/} (network/timeout)"
      ;;
    401 | 403)
      log "report rejected (HTTP ${status}): agent token invalid or disabled"
      ;;
    *)
      log "report failed with HTTP ${status}"
      ;;
  esac

  sleep "$INTERVAL"
done
