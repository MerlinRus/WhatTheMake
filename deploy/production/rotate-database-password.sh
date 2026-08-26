#!/usr/bin/env bash
set -euo pipefail

deployment_root=${1:-/srv/whatthemake}
release_root=$(readlink -f "$deployment_root/current")
compose_file="$release_root/deploy/production/compose.yml"
shared_environment="$deployment_root/shared/.env"
release_environment="$release_root/.release.env"

test -f "$compose_file"
test -f "$shared_environment"
test -f "$release_environment"

new_password=$(openssl rand -hex 32)

printf "ALTER ROLE wtm PASSWORD '%s';\n" "$new_password" |
  docker exec -i whatthemake-postgres-1 \
    psql -v ON_ERROR_STOP=1 -U wtm -d wtm >/dev/null

umask 077
printf 'POSTGRES_PASSWORD=%s\n' "$new_password" >"$shared_environment"
chmod 600 "$shared_environment"
unset new_password

docker compose -p whatthemake \
  --env-file "$shared_environment" \
  --env-file "$release_environment" \
  -f "$compose_file" up -d --no-deps --force-recreate web

for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:8790/api/v1/ready >/dev/null; then
    echo 'Database password rotated; application is ready.'
    exit 0
  fi
  sleep 2
done

echo 'Database password rotated, but application readiness failed.' >&2
exit 1
