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
are untouched. Backup preflight requires 4 GiB reserve, 1 GiB growth headroom,
twice the measured media size and twice the database size on both backup and
Docker filesystems. Restore separately checks extraction headroom. These are
conservative preflights, not hard quotas against concurrent host writes. Restore PG
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

Use the previous release directory and its `.release.env`. New schemas are
additive and old migration checksums are preserved; the PostgreSQL volume stays
intact. Image rollback does not undo account/guest deletions, expired-cache
cleanup, published facts or new user data. Never restore an old dump over live
data merely to revert application code. Keep the pre-release verified backup.

```bash
ln -sfn /srv/whatthemake/releases/<previous-release> /srv/whatthemake/current
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml up -d
curl --fail --silent http://127.0.0.1:8790/api/v1/ready
```

The preceding release lacks the new quota and seven-day cache policies. A
rollback is temporary incident containment, not a way to retain those controls;
restore the forward-fixed release promptly. If the old image lacks the provider
status CLI, pause `whatthemake-provider-monitor.timer` during that rollback and
re-enable it after the forward fix. The backup timer remains independent.

## Private workflows and evidence

- [Review moderation queue and explicit decisions](REVIEW_MODERATION.md).
- [Durable provider limits and passive monitoring](PROVIDER_MONITOR.md).
- Ingredient-function publication: `node /app/apps/server/dist/cli/seed-ingredient-knowledge.js --dry-run`,
  inspect its report, then `--apply`. The initial two facts do not imply a complete
  ingredient knowledge base or medical/safety assessment.
- The web container is bounded to 768 MiB memory / 128 PIDs. Uploads reserve 4 GiB
  free space within one process; this is not a per-user or filesystem quota.
- Post-deploy scripts under `tools/`: public smoke; private-flow smoke with
  disposable guests; opt-in live OCR smoke using one synthetic image; opt-in
  small GTIN-source observation. Run executable verification on the server.
  Live OCR spends one normal quota admission; no real customer photo is used.

## Rotate database password

```bash
/srv/whatthemake/current/deploy/production/rotate-database-password.sh
```
