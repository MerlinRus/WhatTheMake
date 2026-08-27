#!/usr/bin/env bash
set -Eeuo pipefail

deployment_root=${1:-/srv/whatthemake}
release_root=$(readlink -f "$deployment_root/current")
compose_file="$release_root/deploy/production/compose.yml"
shared_environment="$deployment_root/shared/.env"
release_environment="$release_root/.release.env"
shared_directory=$(dirname "$shared_environment")

test -f "$compose_file"
test -f "$shared_environment"
test -f "$release_environment"
test "$(stat -c %a "$shared_environment")" = 600
test "$(grep -c '^POSTGRES_PASSWORD=' "$shared_environment")" -eq 1

old_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$shared_environment")
if [[ ! "$old_password" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo 'Existing database password has unexpected format.' >&2
  exit 1
fi

umask 077
new_password=$(openssl rand -hex 32)
candidate_environment=$(mktemp "$shared_directory/.env.candidate.XXXXXX")
rollback_environment=$(mktemp "$shared_directory/.env.rollback.XXXXXX")
database_changed=0
rotation_succeeded=0

remove_sensitive_file() {
  local path=$1
  if [[ -n "$path" && -f "$path" ]]; then
    shred -u "$path" 2>/dev/null || rm -f "$path"
  fi
}

set_database_password() {
  local password=$1
  printf "ALTER ROLE wtm PASSWORD '%s';\n" "$password" |
    docker exec -i whatthemake-postgres-1 \
      psql -v ON_ERROR_STOP=1 -U wtm -d wtm >/dev/null
}

recreate_web() {
  docker compose -p whatthemake \
    --env-file "$shared_environment" \
    --env-file "$release_environment" \
    -f "$compose_file" up -d --no-deps --force-recreate web
}

wait_until_ready() {
  local attempt
  for attempt in {1..20}; do
    if curl --fail --silent \
      http://127.0.0.1:8790/api/v1/ready >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_environment() {
  local restore_environment
  restore_environment=$(mktemp "$shared_directory/.env.restore.XXXXXX")
  cp -p -- "$rollback_environment" "$restore_environment"
  chmod 600 "$restore_environment"
  chown root:root "$restore_environment"
  mv -f -- "$restore_environment" "$shared_environment"
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e

  if [[ "$status" -ne 0 && "$database_changed" -eq 1 &&
    "$rotation_succeeded" -eq 0 ]]; then
    echo 'Rotation failed; restoring previous database credentials.' >&2
    set_database_password "$old_password"
    restore_environment
    recreate_web
    if wait_until_ready; then
      echo 'Rollback complete; application is ready.' >&2
    else
      echo 'Rollback attempted; application readiness still failed.' >&2
    fi
  fi

  remove_sensitive_file "$candidate_environment"
  remove_sensitive_file "$rollback_environment"
  unset old_password new_password
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT
trap 'exit 143' TERM

sed \
  "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$new_password/" \
  "$shared_environment" \
  >"$candidate_environment"
test "$(grep -c '^POSTGRES_PASSWORD=' "$candidate_environment")" -eq 1
cmp --silent \
  <(sed '/^POSTGRES_PASSWORD=/d' "$shared_environment") \
  <(sed '/^POSTGRES_PASSWORD=/d' "$candidate_environment")
test "$(grep -c '^GOOGLE_VISION_API_KEY=' "$candidate_environment")" -eq \
  "$(grep -c '^GOOGLE_VISION_API_KEY=' "$shared_environment")"
test "$(grep -c '^DEEPSEEK_API_KEY=' "$candidate_environment")" -eq \
  "$(grep -c '^DEEPSEEK_API_KEY=' "$shared_environment")"

cp -p -- "$shared_environment" "$rollback_environment"
chmod 600 "$rollback_environment"
chown root:root "$rollback_environment"
chmod 600 "$candidate_environment"
chown root:root "$candidate_environment"

set_database_password "$new_password"
database_changed=1
mv -f -- "$candidate_environment" "$shared_environment"
candidate_environment=

recreate_web
if ! wait_until_ready; then
  echo 'Database password rotated, but application readiness failed.' >&2
  exit 1
fi

rotation_succeeded=1
database_changed=0
echo 'Database password rotated; application is ready.'
