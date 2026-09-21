# OCR cache retention: technical behavior

The shared PostgreSQL OCR cache stores recognized text and a versioned request
digest, not image bytes. It is not linked to an individual guest/account. Deleting
one identity therefore does not selectively delete this shared cache. Private
photos and saved ingredient revisions follow their separate erasure workflow.

Migration `0019_ocr_cache_retention.sql` makes L2 entries unavailable seven days
after creation. Existing rows retain their original age (`created_at + 7 days`);
already expired rows are removed during migration. Reads never extend expiry.
A new provider result can replace an expired entry and starts a new seven-day
period. Repeated writes against an unexpired key do not overwrite or extend it.

Every cache write removes at most 100 expired rows, with row locks and
`SKIP LOCKED`. Active entries remain untouched. This is opportunistic physical
cleanup, not a guarantee that expired database rows disappear at the exact expiry
time: without writes they can remain stored but unavailable to cache reads.

The existing in-memory L1 has a configured TTL (validated maximum one hour) and
entry-count bound. An L2 result loaded shortly before expiry can remain available
in L1 for that additional configured TTL. Account/guest erasure does not promise
immediate invalidation of other users' shared cache entries or process memory.

Provider-side retention and database backup retention are independent. This note
documents implementation behavior, not legal compliance or provider guarantees.
Avoid UI wording that promises all OCR-derived text disappears immediately or
physically within exactly seven days.

Regression coverage in `packages/infrastructure/test/ocr-cache.test.ts` uses a
transaction-local temporary table to exercise the actual migrations and queries:
legacy age, expired misses, fresh hits, non-renewal of active entries, expired-key
refresh, and a maximum 100-row cleanup batch. Execute it on the isolated server
test database; no local tests were run for this change.
