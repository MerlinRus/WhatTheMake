#!/bin/sh
set -eu
umask 077
exec 9>/run/lock/whatthemake-provider-monitor.lock
flock -n 9 || exit 0
# Read the active container's own configuration; never print or source credentials.
exec docker exec whatthemake-web-1 node /app/apps/server/dist/cli/provider-status.js --maintain --json
