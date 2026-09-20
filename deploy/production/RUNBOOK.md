# Production runbook

Production root: `/srv/whatthemake`. Compose project: `whatthemake`. The
application is reachable only through Nginx at `127.0.0.1:8790`.

TLS renewal is handled by `snap.certbot.renew.timer`. The deploy hook at
`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` validates and reloads
Nginx after a renewed certificate is written.

## Health

```bash
curl --fail --silent https://whatthemake.ru/api/v1/live
curl --fail --silent https://whatthemake.ru/api/v1/ready
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml ps
```

## Logs

```bash
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml logs --tail=200 web
```

## Mascara seed import

The bundled Open Beauty Facts snapshot is immutable by `datasetId` and
`datasetVersion`. Always inspect the conflict/quarantine report before publish.

```bash
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml \
  exec -T web npm run db:seed:mascara -- --dry-run

docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml \
  exec -T web npm run db:seed:mascara
```

Rollback refuses to mutate catalog rows if their imported barcode/family/variant
relationships have drifted:

```bash
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml \
  exec -T web npm run db:seed:mascara -- \
  --rollback open-beauty-facts-mascara@2026-08-26
```

## INCI dictionary publication

The bundled dictionary is immutable and checksum-bound. The Docker verification
target must pass `npm run --silent benchmark:inci` before publication. Always
run the database preview first and compare version, checksum, ingredient count,
and alias count.

```bash
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml \
  exec -T web npm run db:seed:inci-dictionary -- --dry-run

docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml \
  exec -T web npm run db:seed:inci-dictionary
```

The second command is idempotent for the same version and checksum. A different
artifact for an already published version fails closed. For the first v1
publication, deploy and verify the new application image first, confirm the
preview reports `READY` with no current/conflicting snapshot, then publish and
repeat readiness plus one INCI-analysis smoke check.

Application rollback does not roll back the active dictionary. The current and
previous application images use the same cautious dictionary contract, so v1
may remain published during an image rollback. If that compatibility check
fails, stop analysis traffic and use a reviewed controlled retirement procedure;
never edit names, aliases, version, or checksum in a published snapshot. Atomic
dictionary rotation/retirement is a separate operational feature and is not
emulated with ad-hoc SQL in this runbook.

## Verified backups

`backup.sh` captures PostgreSQL and private media without stopping the site,
then `verify-restore.sh` restores the dump into an isolated, resource-limited
temporary database. It checks every active media record against the restored
file's size and SHA-256. An online copy that races deletion fails verification
and is not published as a usable backup. This check does not prove application
startup or an offsite disaster recovery; release tests cover application startup.

Successful copies are `/srv/whatthemake/backups/YYYYMMDDTHHMMSSZ` (mode 0700).
`latest-verified` records the last success. Own dated copies and failed partials
older than 14 days are removed only after a new successful copy; legacy dumps
are untouched. Backups refuse to start with less than 4 GiB free. Restore PG
uses 512 MiB tmpfs / 768 MiB memory; revise these limits when database growth
requires it, without exhausting production memory.

```sh
sh /srv/whatthemake/ops/current/backup.sh
systemctl status whatthemake-backup.timer whatthemake-backup.service
journalctl -u whatthemake-backup.service --since '2 days ago'
```

The daily timer is UTC 03:20 plus up to ten minutes jitter. A failed service or
a `latest-verified` older than 36 hours requires attention. No user data is sent
to a third party: offsite storage remains unconfigured until a destination is
authorized and available. A same-host backup does not protect against host loss.
Operational scripts are installed independently under `/srv/whatthemake/ops/<git-sha>`;
the `ops/current` symlink identifies their revision without restarting the app.

## Application rollback

Use the previous release directory and its `.release.env`. The initial
migration is additive; the PostgreSQL volume remains intact.

```bash
ln -sfn /srv/whatthemake/releases/<previous-release> /srv/whatthemake/current
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml up -d
curl --fail --silent http://127.0.0.1:8790/api/v1/ready
```

## Rotate database password

```bash
/srv/whatthemake/current/deploy/production/rotate-database-password.sh
```
