# Implementation Plan: Mascara comparison MVP

## 1. Overview

Deliver the approved comparison spec as one stateless production vertical slice:

```text
strict request contract
  -> exact local GTIN resolution
  -> fixed-origin Open Beauty Facts fallback for local misses
  -> trusted server-side review signal boundary
  -> deterministic mascara recommender
  -> typed Fastify preview endpoint
  -> React 2–3 slot collection and results
  -> server-only unit/integration/Playwright gates
  -> reviewed immutable production release
```

The slice does not add a database migration, external review data, prices or
history. Discovery records are ephemeral, attributed and never canonical.
Missing review/price evidence remains explicit and can produce
`NO_CLEAR_WINNER`.

## 2. Architecture decisions

1. **Contract first.** Export a reusable `CatalogVariantSchema`, then define
   comparison input, slot, recommendation, criterion, evidence and response
   discriminated unions in `@wtm/contracts`.
2. **Pure domain engine.** Recommendation accepts resolved candidate snapshots,
   trusted review signals, a frozen brief and an injected clock. It performs no
   I/O and returns stable reason codes. Tests can therefore freeze time and prove
   determinism.
3. **Lexicographic tiers.** Hard constraints, goals, review evidence and
   formula/claim observations are compared in order. No hidden weighted total is
   computed or returned.
4. **Reviews are server-owned.** A `ComparisonReviewSignalProvider` is injected
   into the service. Request bodies never contain rating data. Production starts
   with a typed no-data provider; unit fixtures prove rating/sample/freshness
   behavior.
5. **Reuse catalog lookup.** Comparison service calls the existing
   `CatalogLookupService`, preserving exact variant mapping and public
   provenance instead of creating a second catalog mapper.
6. **Partial failures stay in-band.** Unknown or checksum-invalid slots return a
   typed slot state and keep successful slots. Structurally invalid requests use
   the existing `VALIDATION_ERROR` envelope.
7. **No persistence.** Preview endpoint is `POST` because the brief and up to
   three GTINs are structured input, but it performs no mutation and emits
   `Cache-Control: no-store`.
8. **UI state separated from rendering.** A small pure session reducer owns slot
   collection, mode and request lifecycle. React components render the reducer
   state and strict decoded server response.
9. **Scanner stays local.** Comparison reuses the lazy barcode scanner and never
   uploads camera frames.
10. **Server-only verification.** No local build/test command. Exact Git archive
    is tested in Docker on the production host before symlink switch.
11. **Discovery is a trust boundary.** Browser first uses the unchanged local
    catalogue endpoint, then automatically calls one dedicated discovery route
    on `404`. The adapter accepts only a normalized GTIN and owns its fixed
    Open Beauty Facts v3 URL, selected fields, User-Agent, timeout, byte limit,
    redirect allowlist, in-flight dedupe and bounded TTL cache.
12. **External is not canonical.** A discovered product is rendered as an
    `EXTERNAL_CANDIDATE` with low confidence, source attribution and a photo
    confirmation action. It is not persisted, cannot be marked `READY`, and
    forces `NO_CLEAR_WINNER` in comparison.

## 3. Dependency graph

```text
Task 1 contracts (discovery + comparison)
  ├─> Task 2 discovery provider/service/route
  │     └─> Task 7 automatic web fallback
  ├─> Task 3 domain recommender
  │     └─> Task 4 orchestration service
  │           └─> Task 5 route/composition
  │                 └─> Task 6 DB-backed API integration
  └─> Task 7 web session and discovery UI
        └─> Task 8 slot collection UI
              └─> Task 9 result/personalization UI
                    └─> Task 10 Playwright UX coverage

Tasks 1–10 -> Task 11 review/simplify -> Task 12 release/deploy
```

## 4. Task list

### Phase 1 — Public contract and domain rules

## Task 1: Define strict discovery and comparison contracts

**Description:** Refactor the nested public catalog variant schema into an
exported reusable schema, then add additive comparison request/response schemas
and static types.

**Acceptance criteria:**

- [ ] Request accepts exactly two or three syntactically valid GTIN strings and
      one strict existing mascara brief.
- [ ] Slot/recommendation/criterion/evidence unions reject unknown fields and
      impossible mixed states.
- [ ] Public response exposes no score, hidden weight, probability or client
      supplied review signal.
- [ ] Discovery union separates `FOUND`, `NOT_FOUND` and bounded `UNAVAILABLE`
      reasons; an external candidate cannot satisfy a canonical slot schema.

**Verification:**

- [ ] Focused server command:
      `node --import tsx --test packages/contracts/test/contracts.test.ts`.
- [ ] Positive fixtures for 2/3 slots and every union branch.
- [ ] Negative fixtures for 1/4 slots, extra fields, review injection and mixed
      discriminator states.

**Dependencies:** None.
**Files likely touched:**

- `packages/contracts/src/catalog.ts`
- `packages/contracts/src/comparison.ts`
- `packages/contracts/src/product-discovery.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`

**Estimated scope:** M, 5 files.

## Task 2: Implement safe Open Beauty Facts discovery

**Description:** Define the provider boundary, build a fixed-origin Open Beauty
Facts API v3 adapter, then expose a rate-limited public service/route for exact
local misses.

**Acceptance criteria:**

- [ ] Only normalized checksum-valid GTINs can form an upstream request; client
      input cannot control scheme, host, path or selected fields.
- [ ] Adapter sends a custom User-Agent, enforces timeout/byte limit/redirect
      allowlist, validates bounded response data, deduplicates in-flight calls
      and caches bounded success/miss results in memory.
- [ ] Found data stays ephemeral, attributed and low confidence; no database,
      LLM, paid call or remote image is involved.

**Verification:**

- [ ] Fixture transport tests cover found, miss, timeout, 429, malformed/large
      response, hostile strings/URLs, redirect escape, cache and dedupe.
- [ ] Fastify injection covers invalid GTIN, all union branches, no-store and
      route rate limit.
- [ ] Production smoke checks one known Open Beauty Facts barcode and one miss
      without persisting either.

**Dependencies:** Task 1.
**Files likely touched:**

- `packages/domain/src/product-discovery.ts`
- `packages/infrastructure/src/open-beauty-facts-product-provider.ts`
- `apps/server/src/product-discovery/service.ts`
- `apps/server/src/routes/product-discovery.ts`
- focused tests and package indices

**Estimated scope:** M, focused vertical slice.

## Task 3: Implement deterministic mascara recommender

**Description:** Add pure candidate/review/criterion types and lexicographic
recommendation rules. Reuse existing INCI parsing/lookup normalization for exact
avoided-ingredient observations.

**Acceptance criteria:**

- [ ] Waterproof and exact avoided-ingredient constraints cannot be overridden
      by claims or reviews.
- [ ] Personalized goals use explicit manufacturer claim kinds; unknown-goals
      mode requires comparable trusted review evidence unless a hard constraint
      differentiates products.
- [ ] Review sample size, age and source quality gate evidence confidence; tiny,
      stale, missing or close samples yield no winner.

**Verification:**

- [ ] Focused server command:
      `node --import tsx --test packages/domain/test/comparison.test.ts`.
- [ ] Golden pairs: hard-constraint counterexample, personalized claim winner,
      strong review winner, stale/tiny sample no-winner, conflicting criteria,
      missing formula and duplicate candidate.
- [ ] Same frozen input/clock deep-equals across repeated runs; candidate order
      changes presentation order only, not winner identity.

**Dependencies:** Task 1.
**Files likely touched:**

- `packages/domain/src/comparison.ts`
- `packages/domain/src/index.ts`
- `packages/domain/test/comparison.test.ts`
- `package.json`

**Estimated scope:** M, 4 files.

### Checkpoint A: contract/domain

- [ ] Contract and domain focused tests green on server.
- [ ] TypeScript public surface contains one version only.
- [ ] No I/O, DB, LLM or paid provider in domain engine.
- [ ] No public numerical score.

### Phase 2 — Server vertical slice

## Task 4: Build comparison orchestration service

**Description:** Resolve each GTIN through the existing catalog service, preserve
partial failures, detect duplicate exact variants, fetch trusted review signals
once, call the domain engine and map reason codes to bounded Russian copy.

**Acceptance criteria:**

- [ ] Unknown and checksum-invalid GTINs remain typed slot results without
      deleting ready slots.
- [ ] Duplicate input strings fail validation; different GTINs resolving to one
      variant become `DUPLICATE_VARIANT` and force no-winner.
- [ ] Review signals come only from injected provider; production no-data
      provider produces explicit review `NO_DATA`.
- [ ] Any externally discovered slot remains `EXTERNAL_CANDIDATE` and forces
      `EXTERNAL_IDENTITY_UNCONFIRMED`, never a preferred result.

**Verification:**

- [ ] Focused server command:
      `node --import tsx --test apps/server/test/comparison-service.test.ts`.
- [ ] Fake catalog/review providers assert bounded call counts and no client
      review path.
- [ ] Output passes `ComparisonPreviewResponseSchema` runtime validation.

**Dependencies:** Tasks 1–3.
**Files likely touched:**

- `apps/server/src/comparison/service.ts`
- `apps/server/test/comparison-service.test.ts`
- `package.json`

**Estimated scope:** M, 3 files.

## Task 5: Expose preview route and compose production service

**Description:** Register the typed `POST /api/v1/comparisons/preview` route,
reuse one catalog service instance in startup and inject the no-data review
provider.

**Acceptance criteria:**

- [ ] Valid preview returns `200`, `Cache-Control: no-store` and strict response.
- [ ] Schema failures return existing `400 VALIDATION_ERROR`; endpoint has a
      conservative per-IP rate limit.
- [ ] Startup keeps existing catalog route behavior and adds no migration or new
      environment variable.

**Verification:**

- [ ] Fastify injection test covers 200/400/429 schemas and no-store header.
- [ ] Existing app, health and catalog route tests remain green.
- [ ] `npm run typecheck` succeeds in server Docker context.

**Dependencies:** Task 3.
**Files likely touched:**

- `apps/server/src/routes/comparisons.ts`
- `apps/server/src/app.ts`
- `apps/server/src/server.ts`
- `apps/server/test/app.test.ts`

**Estimated scope:** M, 4 files.

## Task 6: Add DB-backed comparison integration test

**Description:** Run comparison through real migrations, PostgreSQL catalog,
public route and no-data review provider using isolated test data.

**Acceptance criteria:**

- [ ] Two published variants resolve through exact GTINs with provenance.
- [ ] One unknown third GTIN preserves two ready slots and forces explainable
      no-winner.
- [ ] Database/catalog failure maps to stable server failure without leaking SQL
      or credentials.

**Verification:**

- [ ] Focused server command with isolated `TEST_DATABASE_URL`:
      `node --import tsx --test --test-concurrency=1 apps/server/test/comparisons.integration.test.ts`.
- [ ] Test database/container removed after completion.

**Dependencies:** Task 4.
**Files likely touched:**

- `apps/server/test/comparisons.integration.test.ts`
- `package.json`

**Estimated scope:** S, 2 files.

### Checkpoint B: API

- [ ] Contract, domain, service, route and DB integration tests green on server.
- [ ] Existing catalog endpoint response unchanged.
- [ ] Preview endpoint is stateless, no-store and rate-limited.
- [ ] Production provider exposes no fabricated review data.

### Phase 3 — Web vertical slice

## Task 7: Implement web session model and automatic discovery fallback

**Description:** Model initial product, 2–3 unique GTIN slots, quick/personalized
brief, add/remove/replace transitions and request lifecycle independently of
React rendering. On existing catalogue `404`, automatically call discovery once
and map `FOUND`, `NOT_FOUND` and `UNAVAILABLE` without a second user action.

**Acceptance criteria:**

- [ ] Initial exact product is immutable slot 1; slots 2–3 can be added, replaced
      or removed without corrupting order.
- [ ] Duplicate GTIN entry is rejected before network request.
- [ ] Stale async responses cannot overwrite a newer comparison request.
- [ ] A local miss transitions through visible discovery loading; external data
      is labelled unverified and preserves the existing photo path.

**Verification:**

- [ ] Focused server command:
      `node --import tsx --test apps/web/test/comparison-session.test.ts`.
- [ ] Transition/property fixtures cover two/three slots, close/reset and stale
      response race.

**Dependencies:** Tasks 1–2.
**Files likely touched:**

- `apps/web/src/comparison-session.ts`
- `apps/web/test/comparison-session.test.ts`
- `package.json`

**Estimated scope:** M, 3 files.

## Task 8: Build slot collection and scanner UI

**Description:** Activate the product CTA, open comparison workspace with slot 1
frozen, collect second/third GTIN by manual input or local scanner and submit
quick-mode preview.

**Acceptance criteria:**

- [ ] Existing single-product lookup remains unchanged until CTA click.
- [ ] Manual and camera paths add exact slot GTINs; camera tracks stop on every
      exit path.
- [ ] Loading, invalid, duplicate, not-found and retry states are accessible and
      never erase successful slots.

**Verification:**

- [ ] Web typecheck/build inside server Docker.
- [ ] Existing scanner session unit tests remain green.
- [ ] Manual browser smoke confirms keyboard focus returns after scanner close.

**Dependencies:** Tasks 4 and 6.
**Files likely touched:**

- `apps/web/src/comparison.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`

**Estimated scope:** M, 3 files.

## Task 9: Render personalization and explainable results

**Description:** Add quick/personalized mode controls, strict response decoding,
recommendation/no-winner header, responsive slot cards and six separate
criterion rows with evidence/confidence.

**Acceptance criteria:**

- [ ] Personalized form produces existing strict brief shape and enforces goal/
      avoided-ingredient bounds before request.
- [ ] Review and price absence renders `Нет разрешённых данных`, never zero.
- [ ] Narrow layout stacks without horizontal page overflow; wide layout aligns
      criteria by slot; server text renders as text, not HTML.

**Verification:**

- [ ] Runtime response must pass `Value.Check` before rendering.
- [ ] Browser visual QA at 320/390/1280 px.
- [ ] Keyboard traversal, labels, focus outlines and live result announcement
      manually checked.

**Dependencies:** Task 7.
**Files likely touched:**

- `apps/web/src/comparison.tsx`
- `apps/web/src/comparison-results.tsx`
- `apps/web/src/styles.css`

**Estimated scope:** M, 3 files.

## Task 10: Add discovery and comparison Playwright coverage

**Description:** Mock typed API responses while serving the real built web UI,
cover quick/personalized and partial-failure flows in isolated server containers.

**Acceptance criteria:**

- [ ] Two-slot quick flow reaches `NO_CLEAR_WINNER` with explicit missing review
      and price evidence.
- [ ] Personalized goal fixture selects a better-fit variant; three-slot partial
      not-found keeps ready slots.
- [ ] Manual and scanner add paths work; 320 px and wide viewport have no page
      overflow or slot identity loss.
- [ ] Existing single-product lookup automatically shows external found,
      confirmed miss and provider-unavailable states after a local `404`.

**Verification:**

- [ ] Build Docker `e2e` target on server.
- [ ] Start disposable Vite container and Playwright container on one temporary
      Docker network; run `npm run test:e2e -- tests/comparison.spec.ts`.
- [ ] Exact temporary containers/network removed after run.

**Dependencies:** Task 8.
**Files likely touched:**

- `tests/comparison.spec.ts`

**Estimated scope:** M, 1 focused test file.

### Checkpoint C: complete user flow

- [ ] 2-slot, 3-slot, quick, personalized and partial-not-found flows pass.
- [ ] Mobile/wide layouts verified visually.
- [ ] Scanner remains local and closes every media track.
- [ ] Missing data is explicit; no universal score appears in API or UI.

### Phase 4 — Review, simplification and release

## Task 11: Review and simplify complete diff

**Description:** Apply multi-axis code review, security review and
code-simplification to the full spec diff before commit.

**Acceptance criteria:**

- [ ] Correctness review checks contract/spec parity, lexicographic precedence,
      partial failures and deterministic ordering.
- [ ] Security review checks input bounds, XSS, denial-of-service, review signal
      trust boundary, upstream SSRF/redirects/response limits, logs and rate
      limits.
- [ ] Simplification removes duplicate mapping/state logic without weakening
      schemas or evidence traceability.

**Verification:**

- [ ] All required findings fixed and regression-tested.
- [ ] `rg` confirms no `dangerouslySetInnerHTML`, client rating input, universal
      score vocabulary or secrets in diff.
- [ ] `git diff --check` and full exact-source Docker verification pass.

**Dependencies:** Tasks 1–10.
**Files likely touched:** only focused fixes found by review, each kept to an S/M
change.
**Estimated scope:** review + bounded fixes.

## Task 12: Commit, push and deploy immutable release

**Description:** Commit spec/plan/code, push `main`, archive exact commit, verify
hash, run all server gates, build runtime image, preflight Compose, switch current
symlink and verify production.

**Acceptance criteria:**

- [ ] Verification image passes benchmark, build, typecheck, lint, format and
      full unit suite; DB integration and comparison Playwright pass separately.
- [ ] New runtime image reports exact Git SHA; web/PostgreSQL are healthy; public
      live/ready and comparison smoke are green.
- [ ] Previous release remains available and documented as rollback target;
      failed candidate never becomes current.

**Verification:**

- [ ] Public `POST /api/v1/comparisons/preview` smoke with two known production
      GTINs returns strict response and expected no-review behavior.
- [ ] In-app browser checks CTA, two-slot quick result, 390 px and desktop layout.
- [ ] Fresh web logs contain no fatal/unhandled errors.

**Dependencies:** Task 11.
**Files likely touched:** none beyond release metadata already tracked.
**Estimated scope:** operational release.

## 5. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Claims accidentally treated as proven performance | High | Separate reason/evidence kinds and fixed copy saying manufacturer claim |
| Review weight becomes hidden universal score | High | Lexicographic comparator, no numeric score in contract, negative schema tests |
| Missing review data favors a product | High | `NO_DATA` semantics and pairwise sufficiency gate |
| Avoided ingredient false match | High | Existing INCI parser + exact normalized token equality only; uncertainty returns no-data |
| Partial lookup wipes valid slots | Medium | Slot union + orchestration tests before UI |
| Duplicate barcode/variant manipulates result | Medium | Input duplicate validation + resolved-variant duplicate detection |
| Large request or evidence response causes DoS | Medium | 2–3 slots, bounded arrays/strings, response schemas and rate limit |
| Server explanation injects HTML | Medium | React text rendering only, XSS Playwright fixture, no HTML API fields |
| UI refactor breaks existing scanner | Medium | Existing scanner tests plus comparison camera E2E |
| No licensed reviews makes quick mode less decisive | Product | Honest no-winner; build trusted boundary now, import data only in approved later slice |
| Upstream data is wrong or malicious | High | Strict bounded decode, fixed text rendering, low-confidence attribution, no canonical write/winner |
| Discovery enables SSRF or traffic amplification | High | Fixed origin/path, normalized GTIN only, redirect allowlist, rate limit, timeout, byte cap, TTL cache/dedupe |
| Open Beauty Facts changes or throttles API | Medium | Typed unavailable states, provider isolation, stable local/photo fallback |

## 6. Parallelization

Contract Task 1 is sequential and blocks all consumers. After Task 1, discovery
Task 2 and comparison domain Task 3 are independent. Server Tasks 4–6 and web
Tasks 7–10 remain sequential within their chains. Review and deploy wait for all
chains.

No subagent work is assumed by this plan. Parallel agents may be introduced only
after an explicit current request and must not edit the same files.

## 7. Plan verification

- Every implementation task has acceptance criteria and an executable server
  verification path.
- No task expects more than five primary files.
- Dependencies follow contract -> domain/service -> route -> UI -> E2E.
- Checkpoints exist after foundation, API and full user flow.
- No migration, dependency, paid provider or external review publication is
  hidden in the plan.
- Production switch occurs only after exact-source gates and preserves rollback.
