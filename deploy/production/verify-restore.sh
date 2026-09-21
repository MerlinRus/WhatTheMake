#!/bin/sh
set -eu
backup=${1:?Pass the absolute backup directory}
case "$backup" in /srv/whatthemake/backups/*) ;; *) exit 2 ;; esac
test -d "$backup"
test ! -L "$backup"
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=$(docker inspect --format '{{.Config.Image}}' whatthemake-web-1)
database="wtm-restore-check-$$"
cleanup() { docker rm -f "$database" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
(cd "$backup" && sha256sum -c SHA256SUMS)
# media.tar is uncompressed; reserve its full size for extraction on Docker's
# filesystem without consuming the application's 4 GiB safety floor.
archive_kb=$(du -k "$backup/media.tar" | awk '{ print $1 }')
docker_root=$(docker info --format '{{.DockerRootDir}}')
available_kb=$(df -Pk "$docker_root" | awk 'NR == 2 { print $4 }')
test "$available_kb" -ge "$((4194304 + 1048576 + archive_kb))" || { printf 'Restore check refused: insufficient media extraction headroom\n' >&2; exit 1; }
docker run -d --rm --name "$database" --network none --memory 768m --cpus 0.5 \
  --tmpfs /var/lib/postgresql:rw,size=512m \
  -e POSTGRES_USER=wtm_restore -e POSTGRES_DB=wtm_restore \
  -e POSTGRES_PASSWORD=restore-test-only postgres:18.6-alpine3.24 >/dev/null
attempt=0
until docker exec "$database" pg_isready -h 127.0.0.1 -U wtm_restore -d wtm_restore >/dev/null 2>&1; do
  attempt=$((attempt + 1)); test "$attempt" -lt 30; sleep 1
done
docker exec -i "$database" pg_restore --exit-on-error --no-owner --no-privileges \
  -U wtm_restore -d wtm_restore < "$backup/database.dump"
docker run --rm --user 0 --memory 512m --cpus 0.5 --network "container:$database" \
  -v "$backup:/backup:ro" \
  -v "$script_root/verify-restored-media.mjs:/app/verify-restored-media.mjs:ro" \
  "$image" sh -c 'mkdir -p /restore/media && tar -xf /backup/media.tar -C /restore/media && node /app/verify-restored-media.mjs'
