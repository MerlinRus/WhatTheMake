#!/bin/sh
set -eu
umask 077
root=/srv/whatthemake/backups
mkdir -p "$root"
chmod 700 "$root"
exec 9>/run/lock/whatthemake-backup.lock
flock -n 9 || exit 0
available_kb=$(df -Pk "$root" | awk 'NR == 2 { print $4 }')
test "$available_kb" -ge 4194304 || { printf 'Backup refused: less than 4 GiB free\n' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$(mktemp -d "$root/.partial-$stamp-XXXXXX")
image=$(docker inspect --format '{{.Config.Image}}' whatthemake-web-1)
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/whatthemake/media"}}{{.Name}}{{end}}{{end}}' whatthemake-web-1)
test "$volume" = whatthemake_wtm_media_data
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
