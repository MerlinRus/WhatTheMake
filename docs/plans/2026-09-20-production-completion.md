# Production completion: What The Make

Authority: user accepted the 2026-09-20 readiness review and requested autonomous implementation of all stages, including verification. Existing server-only testing and deployment preferences continue. This plan supersedes ask-first gates in earlier slice documents for changes necessary to implement that accepted report.

## Objective and acceptance

A shopper can identify a mascara by GTIN or packaging, obtain an attributed ingredient/claims analysis, compare two or three confirmed variants using their constraints, real review evidence and price, and retain/correct/delete their own results. Unknown facts stay unknown. A missing public catalogue entry must not prevent a private analysis. Recommendations must never select a known hard-constraint violation.

Keep TypeScript/TypeBox/Fastify/React/PostgreSQL and existing provider ports. No model-generated product facts or synthetic buyer ratings are published as real evidence. Internet search needs a supported machine-accessible provider; missing credentials are a dependency to report, not a reason to abandon independent work or fabricate search results. No new subscription or account is purchased automatically.

## Ordered work

- [x] 1a. Correct hard-constraint eligibility, incomplete comparisons and removal semantics. Add regressions for the reproduced failures and the three-slot tie case.
- [x] 1b. Use the published INCI dictionary/components for exclusions; ambiguity, partial text and missing dictionaries cannot prove absence.
- [x] 1c. Migrate DeepSeek model identity and verify a real accepted structured response. Preserve upstream failures and unsupported categories distinctly.
- [x] Checkpoint 1: build/typecheck/lint/domain/contracts/integration on server; review diff; deploy and smoke.
- [ ] 2a. Define owned product/analysis snapshots, provenance and additive API contracts for private comparisons.
- [ ] 2b. Connect packaging identity, corrected INCI and ingredient functions to a useful single-product result.
- [ ] 2c. Allow owned snapshots as comparison slots; browser confirmation and correction must preserve ownership and uncertainty.
- [ ] Checkpoint 2: real API end-to-end unknown-product flow, IDOR regressions, browser verification.
- [ ] 3a. Introduce bounded exact-GTIN source search and evidence extraction; distinguish match/candidate/conflict/miss/unavailable/category.
- [ ] 3b. Cache and refresh attributed data; preserve formula versions and source dates. Assess independent matching cases before claiming precision.
- [ ] 4a. Implement real buyer reviews, source-aware aggregates/themes and their production provider.
- [ ] 4b. Add user price, consistent units and profile-linked constraints to comparison.
- [ ] Checkpoint 3: meaningful known and unknown product recommendations, no fabricated reviews, no constraint overrides.
- [ ] 5a. Complete account UI, history, correction, deletion and supported password recovery.
- [ ] 5b. Mobile camera/network recovery and accessible result/error states.
- [ ] 6a. Scheduled WTM database/media backup, tested isolated restore, useful provider/cost monitoring and CI.
- [ ] 6b. Independent quality/latency evaluation, release verification and retained rollback.

Each item is implemented as a small coherent slice, with its own contract and regression evidence before the next dependent slice. Do not mark the overall product complete while any required data/provider or user-flow dependency remains unresolved.

## Verification commands and layout

Source: `packages/contracts`, `packages/domain`, `packages/infrastructure`, `apps/server/src`, `apps/web/src`. Tests follow existing package tests and root Playwright tests. Scripts and operational changes live in `deploy/production`; specifications and evidence in `docs`.

All executable verification runs in isolated Docker containers on the existing server, never against production data for destructive tests:

```sh
docker build --target verification -t whatthemake-verification:<release> .
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run test:e2e
curl --fail --silent https://whatthemake.ru/api/v1/ready
```

`test:integration` requires a disposable TEST_DATABASE_URL. Review security/ownership for new endpoints and external inputs; retain existing tests and domain/HTTP boundaries. Use additive migrations and rollback-compatible releases. Formatting follows existing Prettier; ESM imports use `.js`; use discriminated unions and server-owned decisions, e.g. `return { kind: 'NO_CLEAR_WINNER', confidence: 'LOW', reasonCodes: ['HARD_CONSTRAINT_DATA_MISSING'] };`.

## Progress evidence

Initial audit: release 2026.08.31-06, SHA 35a9ad8; 108 base tests passed, 23 integration tests passed, five independent comparison failure probes and live DeepSeek model-mismatch failure reproduced. Details: `docs/reviews/2026-09-20-production-readiness.md`.

2026-09-20 first implementation packet (`readiness-a3`): server build, typecheck,
lint, formatting and INCI benchmark passed. Fresh unit run: 133 total, 118 pass,
15 database-dependent skips, zero failures. Isolated integration: 23 pass, no
skips/failures. Live DeepSeek synthetic structured request succeeded using
`deepseek-flash`; both known oral-rinse/primer probes were OTHER and synthetic
GTIN miss remained NOT_FOUND. Independent review led to visible eye-context
warnings and a separate review-ranking eligibility regression. Browser gate:
9/9 pass after isolating external discovery and making the delayed-camera
fixture retain its canvas/stream and assert native live-to-ended track state.
The server's production dependency audit reports zero vulnerabilities.
Deployed release 2026.09.20-01, SHA 8a2f228ada51803f395e8c28da604e75c1218121.
Public HTTPS readiness reports UP with that SHA, database UP, container healthy;
live oral-rinse lookup is correctly attributed as OTHER. Previous release
2026.08.31-06 remains the rollback target.

Pre-release online backup `/srv/whatthemake/backups/20260920T173732Z` restored
successfully into an isolated temporary database: 31 WTM tables, zero active
media in this production snapshot. Scheduling, bounded restore recheck and
offsite protection are not implied by this successful manual restore.
