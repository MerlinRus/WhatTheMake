#!/bin/sh
set -eu

# Disposable database, no production network, volumes or credentials.
image=${1:?Pass a verified WhatTheMake image tag}
case "$image" in whatthemake-verification:*) ;; *) exit 2 ;; esac
database="wtm-verification-db-$$"
cleanup() { docker rm -f "$database" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker run -d --rm --name "$database" --network none \
  --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=wtm_test -e POSTGRES_DB=wtm_test \
  -e POSTGRES_PASSWORD=isolated-test-only postgres:18.6-alpine3.24 >/dev/null
attempt=0
until docker exec "$database" pg_isready -h 127.0.0.1 -U wtm_test -d wtm_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 30
  sleep 1
done
docker run --rm --network "container:$database" \
  -e TEST_DATABASE_URL=postgresql://wtm_test:isolated-test-only@127.0.0.1:5432/wtm_test \
  "$image" npm run test:integration
