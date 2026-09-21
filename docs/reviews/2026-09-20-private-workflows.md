# Private workflows and production gates

## Scope

This packet adds owned immutable packaging snapshots, corrected-INCI details,
private/public mixed comparison, account/history controls, offline recovery,
account/guest erasure, moderated WTM reviews and conservative review weighting.
It also adds attributed fallback discovery and durable provider invocation quotas.
No reviews, purchases, market prices or product effectiveness are fabricated.

## Evidence boundary

- A private snapshot is a user's confirmation, not manufacturer verification.
  Incomplete or conditional INCI cannot establish the absence of an exclusion.
- Ingredient functions require published source-backed facts. Missing functions
  remain unknown; concentrations, finished-product safety and efficacy are not inferred.
- WTM reviews count only current approved revisions from active accounts for
  the exact published variant. Purchases are unverified; source quality is LOW.
  Recency weighting uses the aggregate update date, not each review's age.
- Open Beauty Facts and UPCitemdb responses remain LOW-confidence candidates.
  The fallback does not merge different sources into a supposedly confirmed card.
  An outage cannot become a clean cross-source miss. Wrong returned codes stop
  resolution; equivalent zero padding is accepted, package indicators are not.
- UPCitemdb uses its documented free lookup endpoint, no signup or new credential.
  Its 100/day and 10.1-second admission spacing are durable. Returned offers and
  images are never fetched. Lookup terms/data availability can change.
- A three-product manufacturer-document holdout and constructed transport tests
  are not an internet precision, coverage or production-latency measurement.

## Security review and corrections

- Private queries enforce ownership, including guest claims, and no-store replies.
- Account reset consumes a random offline recovery code once and revokes sessions.
  Login issuance rechecks the verified password hash under the same account lock.
- Erasure reauthenticates and queues file cleanup before metadata cascades disappear.
  A pending guest deletion cannot erase an already-claimed account's data.
- Deleted accounts retain only a pseudonymous audit row when public moderation
  provenance requires it. Existing backups and shared technical OCR caches are
  separately retained, not instantaneously purged by the deletion button.
- Provider admission fails closed; completed/failed/unresolved admissions never
  refund quota. Restart cannot reset counters. Deadlines bound admission,
  completion and SQL locks. Cached OCR does not spend another request.
- Provider statistics contain fixed enums and numbers, not prompts, photos,
  account identities, GTINs, content hashes, keys or raw upstream errors.
  Invocation quotas are not monetary spending guarantees. DeepSeek is configured
  but currently has no customer-path caller; status reports this explicitly.

## Server verification record

All executable tests run on the server, in disposable containers and databases.
Production remains release 2026.09.20-01 until the final gate and deployment.

- b3: build and typecheck passed. Unit: 164 passed, 24 database-dependent skips,
  zero failures. Integration: 32/33; failing fixture tried inserting a second
  active ingredients photo into a reused observation. Fixture now uses a distinct GTIN.
- b3 browser: 29/31; two selectors accidentally matched shared headings/classes.
  Semantic region and exact private-history heading selectors preserve the original
  focus/privacy assertions. No application checks were removed.
- b3 lint found control-character regexes and a missing caught-error cause; fixed.
- b4: build, offline benchmarks, typecheck, lint and formatting passed. Unit:
  198 passed, 25 database-dependent skips, zero failures. Isolated integration:
  34/34. Mobile Chromium: 33/33. Real private API smoke verified two owned
  snapshots, idempotency, foreign-access denial and incomplete-formula constraints;
  disposable guests were deleted. A test now waits for asynchronous quota completion
  before asserting its recorded outcome; no production behavior was weakened.
- b5/b7 add saved-profile controls, read-only moderation queue, review-topic
  mentions, media/backup capacity guards, and exact saved-revision history.
  A late response from an abandoned analysis is ignored. The b7 Docker build,
  offline benchmarks, typecheck, lint and formatting gate passed. The main unit
  suite reported 230 total: 204 passed, 26 database-dependent skips, zero failures.
  The separate pretest includes media capacity and review-topic checks. The
  b7 mobile browser run failed 1 of 50 cases: a public comparison checkbox was
  rendered non-interactive by a shared full-width input rule; 49 cases passed.
  The CSS rule and an explicit visibility assertion were corrected for b8.
- b8: full isolated release gate exited 0. Docker build, offline benchmarks,
  typecheck, lint and formatting passed. Unit: 204 passed, 26 DB-dependent
  skips, zero failures. Integration against disposable PostgreSQL: 35/35.
  Mobile Chromium: 50/50, including the original public-checkbox regression.
  Private API smoke confirmed ownership, snapshot idempotency and rejection of
  incomplete formulas; both disposable guests were deleted.
- Production remains on release 2026.09.20-01 until commit, push, new verified
  backup, deployment and post-release smokes complete. Do not infer production
  health from the isolated gate alone.

The improved backup preflight was executed against the existing production
image before migration: `/srv/whatthemake/backups/20260920T195520Z` restored
31 tables and zero active media in an isolated database. This is a same-host
copy; no offsite protection is implied.

## Remaining operational limits

Scheduled backups are on the same host; no offsite destination is configured.
The passive provider monitor writes to systemd journal, not an external alert channel.
External source availability, full Russian-market coverage and universal exact
shade/formula identification are not guaranteed. Broad web search still needs a
suitable provider; a language model's memory is not evidence of GTIN identity.
