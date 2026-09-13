#!/bin/sh
set -e

# Fresh named volumes are created root-owned by Docker; this container runs as the non-root
# "node" user (see Dockerfile), which otherwise can't write kangops.sqlite into /data.
# Entrypoint runs as root briefly to fix ownership, then drops to "node" before exec'ing the
# actual app -- the app process itself never runs as root.
chown -R node:node /data

exec su-exec node "$@"
