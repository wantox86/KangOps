#!/bin/sh
# KangOps network collector. Same shape as agent.sh: shell + curl + jq, outbound only.
#
# Every NETWORK_INTERVAL_SECONDS: log in to the ASUS router (ASUSWRT) over its web API, fetch the
# client list, normalise it with network.jq, and POST the online devices to KangOps using the
# same scoped agent token agent.sh uses. It only ever READS from the router. Nothing is
# published on the host; KangOps is the only thing it dials besides the router.
#
# Router login hygiene (a lockout would take the router's admin UI away from the user):
#  - ONE login attempt per cycle, never a retry loop. The session token is reused across cycles
#    and only re-created when the router stops honouring it.
#  - Consecutive login failures back off exponentially (capped at 1h). A rejected credential
#    never gets hammered every 60s.
#  - On shutdown the session is logged out so tokens don't pile up on the router.
# Credentials come from env (ROUTER_USER/ROUTER_PASS) and are never logged or put in argv.
set -eu

COLLECTOR_VERSION="1.0.0"

INTERVAL="${NETWORK_INTERVAL_SECONDS:-60}"
TIMEOUT="${AGENT_HTTP_TIMEOUT_SECONDS:-10}"
ROUTER_URL="${ROUTER_URL:-http://192.168.50.1}"
ROUTER_URL="${ROUTER_URL%/}"
JQ_FILE="${NETWORK_JQ_FILE:-/usr/local/bin/network.jq}"
# ASUSWRT rejects requests without this exact UA on the login/API endpoints.
UA="asusrouter--"
MAX_BACKOFF=3600

for var in KANGOPS_URL KANGOPS_AGENT_TOKEN ROUTER_USER ROUTER_PASS; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "network: $var is required" >&2
    exit 1
  fi
done

REPORT_URL="${KANGOPS_URL%/}/api/v1/agents/${KANGOPS_AGENT_TOKEN}/network"
TOKEN=""
FAILS=0

log() {
  printf '%s network: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

router_logout() {
  if [ -n "$TOKEN" ]; then
    curl -s -o /dev/null --max-time "$TIMEOUT" -A "$UA" -e "$ROUTER_URL/Main_Login.asp" \
      -H "Cookie: asus_token=$TOKEN" "$ROUTER_URL/Logout.asp" 2>/dev/null || true
    TOKEN=""
  fi
}
trap 'router_logout; exit 0' TERM INT

# Prints the asus_token on success, nothing on failure. The login_authorization value is
# base64("user:pass"), URL-encoded, and goes in via stdin so the password never appears in argv.
router_login() {
  auth="$(printf '%s:%s' "$ROUTER_USER" "$ROUTER_PASS" | base64 | tr -d '\n')"
  body="$(AUTH="$auth" jq -rn '"login_authorization=" + (env.AUTH | @uri)')"
  headers="$(
    printf '%s' "$body" | curl -s -D - -o /dev/null --max-time "$TIMEOUT" \
      -A "$UA" -e "$ROUTER_URL/Main_Login.asp" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-binary @- "$ROUTER_URL/login.cgi" 2>/dev/null || true
  )"
  # Newer firmware returns the token as a Set-Cookie header.
  printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: *asus_token=\([^;]*\).*/\1/p' | head -n 1
}

# Prints the raw client-list JSON, or nothing if the session isn't honoured / reply isn't JSON.
router_clientlist() {
  curl -s --max-time "$TIMEOUT" -A "$UA" -e "$ROUTER_URL/index.asp" \
    -H "Cookie: asus_token=$TOKEN" \
    "$ROUTER_URL/appGet.cgi?hook=get_clientlist()" 2>/dev/null | jq -c 'select(.get_clientlist != null)' 2>/dev/null || true
}

log "starting (version ${COLLECTOR_VERSION}, interval ${INTERVAL}s, router ${ROUTER_URL}, server ${KANGOPS_URL%/})"

while :; do
  raw=""
  if [ -n "$TOKEN" ]; then
    raw="$(router_clientlist)"
    if [ -z "$raw" ]; then
      log "router session no longer valid, will log in again"
      TOKEN=""
    fi
  fi

  if [ -z "$raw" ] && [ -z "$TOKEN" ]; then
    # Backoff: after N consecutive failures wait INTERVAL * 2^N (capped) BEFORE trying again.
    if [ "$FAILS" -gt 0 ]; then
      wait_s="$INTERVAL"
      i=0
      while [ "$i" -lt "$FAILS" ] && [ "$wait_s" -lt "$MAX_BACKOFF" ]; do
        wait_s=$((wait_s * 2))
        i=$((i + 1))
      done
      [ "$wait_s" -gt "$MAX_BACKOFF" ] && wait_s="$MAX_BACKOFF"
      sleep "$wait_s" &
      wait $! || true
    fi
    TOKEN="$(router_login)"
    if [ -z "$TOKEN" ]; then
      FAILS=$((FAILS + 1))
      log "router login failed (consecutive failures: ${FAILS}); backing off. Check ROUTER_USER/ROUTER_PASS, do not loop manually (lockout risk)"
      sleep "$INTERVAL" &
      wait $! || true
      continue
    fi
    FAILS=0
    raw="$(router_clientlist)"
    if [ -z "$raw" ]; then
      log "logged in but client list was empty/unparseable"
      router_logout
      FAILS=$((FAILS + 1))
      sleep "$INTERVAL" &
      wait $! || true
      continue
    fi
  fi

  payload="$(printf '%s' "$raw" | jq -c --arg version "$COLLECTOR_VERSION" -f "$JQ_FILE" 2>/dev/null || true)"
  count="$(printf '%s' "$payload" | jq '.devices | length' 2>/dev/null || true)"

  # An empty online list is far more likely a router-side hiccup than a network with zero
  # clients (this very host is a client), and posting it would flip every device offline.
  if [ -z "$count" ] || [ "$count" -eq 0 ]; then
    log "no online devices parsed from router reply, skipping this snapshot"
  else
    status="$(
      printf '%s' "$payload" | curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
        -X POST -H 'Content-Type: application/json' --data-binary @- "$REPORT_URL" 2>/dev/null || printf '000'
    )"
    case "$status" in
      202) : ;;
      000) log "report failed: could not reach ${KANGOPS_URL%/} (network/timeout)" ;;
      401 | 403) log "report rejected (HTTP ${status}): agent token invalid or disabled" ;;
      *) log "report failed with HTTP ${status}" ;;
    esac
  fi

  sleep "$INTERVAL" &
  wait $! || true
done
