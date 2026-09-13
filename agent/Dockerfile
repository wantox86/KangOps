# Alpine + curl + jq and nothing else: ~14MB on disk, a few hundred KB resident. The first
# target host is 97% full and CPU-starved, so every megabyte and every resident process here is
# a cost that has to justify itself -- a Node base image would be ~10x the disk for a script
# that makes one HTTP POST every 30 seconds.
FROM alpine:3.21

# The base image is pinned to a minor (alpine:3.21); the two packages deliberately are not
# pinned to a patch version, because Alpine drops superseded patch releases from its repo and an
# exact pin here would turn the next routine security bump into a broken rebuild.
RUN apk add --no-cache curl jq

COPY agent.sh /usr/local/bin/agent.sh
RUN chmod 0555 /usr/local/bin/agent.sh

# Runs as nobody: the agent reads /host/proc and a read-only bind mount, and talks HTTP to the
# socket proxy. It needs no privileges at all, and never writes to disk.
USER 65534:65534

ENTRYPOINT ["/bin/sh", "/usr/local/bin/agent.sh"]
