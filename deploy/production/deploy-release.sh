#!/bin/sh
set -eu
release=${1:?Pass release name}
sha=${2:?Pass source commit SHA}
case "$release" in *[!a-zA-Z0-9._-]*|'') exit 2 ;; esac
printf '%s\n' "$sha" | grep -Eq '^[a-f0-9]{40}$'
target="/srv/whatthemake/releases/$release"
test -d "$target"
test ! -L "$target"
previous=$(readlink -f /srv/whatthemake/current)
case "$previous" in /srv/whatthemake/releases/*) ;; *) exit 2 ;; esac
test "$previous" != "$target"
sh "$target/deploy/production/verify-release.sh" "$target" "$release"
docker build --target runtime -t "whatthemake-web:$release" "$target"
printf 'WTM_IMAGE=whatthemake-web:%s\nBUILD_SHA=%s\n' "$release" "$sha" > "$target/.release.env"
compose() {
  docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
    --env-file /srv/whatthemake/current/.release.env \
    -f /srv/whatthemake/current/deploy/production/compose.yml "$@"
}
rollback() {
  ln -sfn "$previous" /srv/whatthemake/current
  compose up -d --no-deps web
}
ln -sfn "$target" /srv/whatthemake/current
if ! compose up -d --no-deps web; then rollback; exit 1; fi
attempt=0
until curl --connect-timeout 2 --max-time 5 --fail --silent http://127.0.0.1:8790/api/v1/ready >/dev/null && \
  curl --connect-timeout 2 --max-time 5 --fail --silent http://127.0.0.1:8790/api/v1/live | grep -Fq "$sha"; do
  attempt=$((attempt + 1))
  if test "$attempt" -ge 30; then rollback; exit 1; fi
  sleep 2
done
printf 'Deployed %s (%s); rollback %s\n' "$release" "$sha" "$previous"
