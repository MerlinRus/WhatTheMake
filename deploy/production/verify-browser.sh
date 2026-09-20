#!/bin/sh
set -eu
image=${1:?Pass the verified application image}
source=${2:?Pass the absolute release source directory}
browser_image=${3:?Pass the existing Playwright image}
shift 3
case "$image" in whatthemake-verification:*) ;; *) exit 2 ;; esac
case "$source" in /srv/whatthemake/work/*|/srv/whatthemake/releases/*) ;; *) exit 2 ;; esac
database="wtm-browser-db-$$"
web="wtm-browser-web-$$"
cleanup() { docker rm -f "$web" "$database" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker run -d --rm --name "$database" --network none --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=wtm_browser -e POSTGRES_DB=wtm_browser \
  -e POSTGRES_PASSWORD=browser-test-only postgres:18.6-alpine3.24 >/dev/null
attempt=0
until docker exec "$database" pg_isready -h 127.0.0.1 -U wtm_browser -d wtm_browser >/dev/null 2>&1; do
  attempt=$((attempt + 1)); test "$attempt" -lt 30; sleep 1
done
docker run -d --rm --name "$web" --network "container:$database" \
  -e DATABASE_URL=postgresql://wtm_browser:browser-test-only@127.0.0.1:5432/wtm_browser \
  -e NODE_ENV=test -e PUBLIC_ORIGIN=http://127.0.0.1:8787 \
  "$image" node apps/server/dist/server.js >/dev/null
attempt=0
until docker exec "$web" node -e 'fetch("http://127.0.0.1:8787/api/v1/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; do
  attempt=$((attempt + 1)); test "$attempt" -lt 30; sleep 1
done
docker run --rm --network "container:$database" \
  -e E2E_BASE_URL=http://127.0.0.1:8787 \
  -v "$source/tests:/app/tests:ro" \
  -v "$source/playwright.config.ts:/app/playwright.config.ts:ro" \
  -v "$source/test-results:/app/test-results" \
  "$browser_image" npm run test:e2e -- --workers=1 "$@"
