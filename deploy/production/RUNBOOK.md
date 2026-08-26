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

## Rollback

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
