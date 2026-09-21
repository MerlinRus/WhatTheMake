#!/bin/sh
set -eu
umask 077
root=/srv/whatthemake/backups
mkdir -p "$root"
chmod 700 "$root"
exec 9>/run/lock/whatthemake-backup.lock
flock -n 9 || exit 0
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
image=$(docker inspect --format '{{.Config.Image}}' whatthemake-web-1)
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/whatthemake/media"}}{{.Name}}{{end}}{{end}}' whatthemake-web-1)
test "$volume" = whatthemake_wtm_media_data
# Account for both the archive and the restore-check copy, plus a conservative
# database allowance and growth headroom. This is a preflight, not a disk quota.
media_kb=$(docker run --rm --user 0 --network none -v "$volume:/media:ro" "$image" du -sk /media | awk '{ print $1 }')
database_kb=$(docker exec whatthemake-postgres-1 psql -X -U wtm -d wtm -Atc "SELECT pg_database_size(current_database()) / 1024 + 1")
case "$media_kb:$database_kb" in *[!0-9:]*|:*|*:) exit 1 ;; esac
required_kb=$((4194304 + 1048576 + 2 * media_kb + 2 * database_kb))
docker_root=$(docker info --format '{{.DockerRootDir}}')
for storage_path in "$root" "$docker_root"; do
  available_kb=$(df -Pk "$storage_path" | awk 'NR == 2 { print $4 }')
  test "$available_kb" -ge "$required_kb" || { printf 'Backup refused: insufficient archive/restore headroom\n' >&2; exit 1; }
done
backup=$(mktemp -d "$root/.partial-$stamp-XXXXXX")
docker exec whatthemake-postgres-1 pg_dump -U wtm -d wtm --format=custom > "$backup/database.dump"
docker run --rm --user 0 --network none -v "$volume:/media:ro" \
  "$image" tar -C /media -cf - . > "$backup/media.tar"
printf '%s\n' "$image" > "$backup/image.txt"
(cd "$backup" && sha256sum database.dump media.tar image.txt > SHA256SUMS)
# An online copy may race a deletion. Only publish a backup whose restored
# database references exclusively present, checksum-correct media; otherwise fail.
sh "$script_root/verify-restore.sh" "$backup"
mv "$backup" "$root/$stamp"
printf '%s\n' "$stamp" > "$root/latest-verified"
printf 'Verified backup: %s\n' "$root/$stamp"
# Only this script's dated directories, never legacy dumps or other projects.
find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +14 | while IFS= read -r expired; do
  name=$(basename -- "$expired")
  printf '%s\n' "$name" | grep -Eq '^([0-9]{8}T[0-9]{6}Z|\.partial-[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]{6})$' || continue
  test ! -L "$expired"
  test "$(realpath -- "$expired")" = "$root/$name"
  test "$name" != "$stamp"
  rm -rf -- "$expired"
done
