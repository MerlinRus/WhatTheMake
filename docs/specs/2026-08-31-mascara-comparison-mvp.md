# Spec: Mascara comparison MVP

## 1. Assumptions

1. Comparison targets exact published `ProductVariant` records resolved by GTIN,
   never product families or free-form names.
2. First production slice supports two required and one optional slot.
3. Guest comparison is stateless and requires no registration. History and
   immutable stored snapshots remain a later slice.
4. Both `UNKNOWN_GOALS` and `PERSONALIZED` modes use the existing versioned
   mascara brief shape.
5. Reviews and ratings influence the algorithm only when a server-side trusted
   aggregate is available. Missing review data is `NO_DATA`, never rating zero.
6. No licensed review aggregate is currently published. The implementation must
   support review signals and test their weight with fixtures, but production
   must not invent or expose synthetic ratings.
7. Price observations and value ranking are out of this slice. The response
   exposes a `PRICE_DATA_UNAVAILABLE` criterion instead of silently ignoring
   price.
8. Existing catalogue, identity, media, INCI and preference contracts remain
   backward compatible. No database migration is required for this slice.
9. A valid GTIN missing from the local catalogue triggers a server-side exact
   lookup in Open Beauty Facts. The external record remains an ephemeral,
   explicitly attributed candidate and is never published into the canonical
   catalogue automatically.
10. External discovery is best-effort. Provider absence, throttling, timeout,
    malformed data and a true miss are distinct outcomes and never erase the
    existing photo-observation fallback.

## 2. Objective

Build an explainable web comparison for a shopper choosing between similar
mascaras at a store shelf.

The shopper can:

1. open a known product card;
2. choose `Сравнить с другим`;
3. scan or enter a second GTIN and optionally a third;
4. use quick `Не знаю, помогите выбрать` mode or provide a
   personalized mascara brief;
5. see a cautious preferred option or `NO_CLEAR_WINNER`;
6. inspect separate criteria, trade-offs, evidence origin and confidence.
7. automatically see a cautious external product candidate when an unknown
   GTIN exists in Open Beauty Facts, or continue with photo submission when it
   does not.

The product must never present a universal safety score, compatibility
percentage, medical conclusion or hidden composite number.

## 3. Unknown-GTIN discovery contract

The existing local endpoint keeps its current catalogue-only semantics. After a
local `404`, the browser automatically calls:

`GET /api/v1/discovery/barcodes/:gtin`

The response is a strict discriminated union:

- `FOUND`: exact requested GTIN plus bounded brand, product name, quantity,
  provider identifier, provider product-page URL, observation time and
  `confidence: LOW`;
- `NOT_FOUND`: exact requested GTIN and provider identifier;
- `UNAVAILABLE`: exact requested GTIN and stable reason
  `TIMEOUT | RATE_LIMITED | UPSTREAM_ERROR | INVALID_RESPONSE | DISABLED`.

Rules:

- only checksum-valid normalized GTINs reach the provider;
- the server constructs one URL on the fixed Open Beauty Facts origin and never
  follows a redirect outside the approved Facts domains;
- requests carry a product-specific `User-Agent`, bounded selected fields,
  timeout, response-size limit, in-flight deduplication and bounded memory TTL
  cache;
- third-party strings are length-limited and validated before entering the
  public response;
- no remote image is embedded in the first slice, preventing an untrusted host
  from observing shopper traffic;
- discovery does not write to PostgreSQL and does not call an LLM, search engine
  or paid API;
- an external candidate never becomes `READY` comparison evidence. If any slot
  is external, the comparison returns `NO_CLEAR_WINNER` until identity is
  confirmed through the canonical catalogue/observation workflow.

## 4. Comparison public contract

### Endpoint

`POST /api/v1/comparisons/preview`

Input:

```ts
interface ComparisonPreviewInput {
  schemaVersion: 1;
  gtins: [string, string] | [string, string, string];
  brief: MascaraBriefInput;
}
```

Boundary rules:

- only 2–3 GTIN strings are accepted;
- input GTIN values must be distinct and checksum-valid;
- two different barcodes resolving to one variant produce a slot-level
  `DUPLICATE_VARIANT` state and no recommendation;
- more than three slots or malformed brief data returns the existing stable
  `VALIDATION_ERROR` envelope;
- a valid but unknown GTIN remains a slot-level `NOT_FOUND` result so successful
  slots are not erased.

Response:

```ts
interface ComparisonPreviewResponse {
  comparison: {
    schemaVersion: 1;
    rulesVersion: 'mascara-comparison-v1';
    mode: 'UNKNOWN_GOALS' | 'PERSONALIZED';
    slots: ComparisonSlot[];
    recommendation:
      | {
          kind: 'PREFERRED';
          productVariantId: string;
          framing: 'BETTER_FIT' | 'UNIVERSAL_CHOICE';
          confidence: 'LOW' | 'MEDIUM' | 'HIGH';
          reasonCodes: ComparisonReasonCode[];
        }
      | {
          kind: 'NO_CLEAR_WINNER';
          confidence: 'LOW' | 'MEDIUM';
          reasonCodes: ComparisonReasonCode[];
        };
    criteria: ComparisonCriterion[];
  };
}
```

Slot states are a discriminated union:

- `READY` contains the exact public catalog variant and nullable trusted review
  aggregate;
- `NOT_FOUND` contains only the normalized GTIN;
- `EXTERNAL_CANDIDATE` contains the bounded discovery result and is explicitly
  non-canonical;
- `INVALID_GTIN` contains a stable validation reason;
- `DUPLICATE_VARIANT` identifies the earlier slot without duplicating product
  evidence.

Criteria are explicit and ordered:

1. `IDENTITY_AND_DATA`;
2. `HARD_CONSTRAINTS`;
3. `DESIRED_EFFECT`;
4. `CUSTOMER_REVIEWS`;
5. `FORMULA_AND_CLAIMS`;
6. `PRICE_AND_VALUE`.

Each criterion contains a per-slot observation with:

- `outcome`: `ADVANTAGE | DISADVANTAGE | NEUTRAL | NO_DATA`;
- `confidence`: `LOW | MEDIUM | HIGH`;
- stable `reasonCode`;
- human-readable Russian explanation from a fixed server-owned message map;
- bounded evidence references to catalog claims, formula revision or review
  aggregate metadata.

No internal weight, rank, probability or composite score is returned.

## 5. Review signal boundary

Comparison consumes a read-only server-side interface. The browser cannot send
rating values.

```ts
interface ComparisonReviewSignal {
  productVariantId: ProductVariantId;
  ratingValue: number;
  reviewCount: number;
  asOf: Date;
  sourceQuality: 'LOW' | 'MEDIUM' | 'HIGH';
  themes: Array<{
    kind:
      | 'VOLUME'
      | 'LENGTH'
      | 'SEPARATION'
      | 'NATURAL_LOOK'
      | 'WATERPROOF'
      | 'EASY_REMOVAL';
    direction: 'POSITIVE' | 'MIXED' | 'NEGATIVE';
    relevantReviewCount: number;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;
}
```

Rules:

- `reviewCount`, freshness and source quality affect evidence strength;
- missing reviews never beat a reviewed product and never behave as zero;
- a tiny or stale sample cannot create a high-confidence winner;
- review themes describe practical experience only;
- reviews cannot override a known hard constraint;
- production uses a no-data provider until a rights-approved aggregate import is
  published.

## 6. Deterministic recommendation rules

### Personalized mode

Apply lexicographic tiers, not one public weighted sum:

1. exact identity and sufficient slot data;
2. known hard constraints: waterproof requirement/avoidance and exact avoided
   ingredient presence in a current formula;
3. requested effect matched by explicit manufacturer claims, labelled as claims;
4. trusted review themes and rating evidence;
5. formula/claim trade-offs;
6. price/value, currently `NO_DATA`;
7. close or contradictory evidence returns `NO_CLEAR_WINNER`.

`sensitiveEyes`, `contactLenses` and easy-removal preferences remain visible but
produce `NO_DATA` unless a published rule or explicit claim supports an
observation. The system must not infer medical suitability.

### Unknown-goals mode

Apply:

1. exact identity and any retained hard constraints;
2. trusted review rating evidence adjusted by sample size, freshness and source
   quality;
3. trusted practical review themes;
4. breadth of explicit manufacturer claims;
5. price/value, currently `NO_DATA`.

When trusted review data is absent, claims alone do not create a universal
winner unless a hard constraint clearly differentiates slots. Return
`NO_CLEAR_WINNER` with `REVIEW_DATA_UNAVAILABLE`.

### Stable no-winner reasons

- `INSUFFICIENT_READY_SLOTS`;
- `EXTERNAL_IDENTITY_UNCONFIRMED`;
- `DUPLICATE_VARIANT`;
- `REVIEW_DATA_UNAVAILABLE`;
- `EVIDENCE_TOO_CLOSE`;
- `CONFLICTING_CRITERIA`;
- `HARD_CONSTRAINT_DATA_MISSING`;
- `NO_SUPPORTED_DIFFERENCE`.

## 7. Web UX

- Existing disabled CTA becomes active.
- First product stays frozen as slot 1 while the existing barcode scanner/manual
  input collects slots 2–3.
- The quick mode is the default and requires no questionnaire.
- Personalized mode exposes goals, waterproof/removal preferences, sensitive
  eyes, contact lenses and a bounded avoided-ingredient list.
- Results use stacked cards on narrow screens and a comparison grid on wide
  screens.
- Every slot shows exact variant identity before any recommendation.
- `NO_CLEAR_WINNER` is a first-class successful result, not an error state.
- Missing reviews and prices display `Нет разрешённых данных`,
  not `0`.
- Users can remove a slot, rescan it or leave comparison without mutating the
  catalog.
- Keyboard focus, live status and 320 px layout remain usable.
- A local catalogue miss automatically enters `Ищем в открытом каталоге…`;
  the shopper does not need to press a second search button.
- An external match is labelled `Open Beauty Facts · данные не проверены`, links
  to its source and offers the existing photo-confirmation path. `NOT_FOUND` and
  `UNAVAILABLE` keep distinct honest copy and the same photo fallback.

## 8. Tech stack and project structure

- TypeScript, TypeBox contracts, Fastify, React/Vite, PostgreSQL-backed catalog.
- `packages/contracts/src/comparison.ts`: strict request/response schemas.
- `packages/contracts/src/product-discovery.ts`: strict discovery union.
- `packages/domain/src/comparison.ts`: deterministic recommender and reason
  codes.
- `packages/domain/src/product-discovery.ts`: provider boundary and validated
  ephemeral candidate.
- `packages/infrastructure/src/open-beauty-facts-product-provider.ts`: fixed-
  origin API v3 adapter with timeout/cache/response limits.
- `apps/server/src/product-discovery/service.ts` and
  `apps/server/src/routes/product-discovery.ts`: orchestration and public route.
- `apps/server/src/comparison/service.ts`: catalog/review orchestration.
- `apps/server/src/routes/comparisons.ts`: validated preview endpoint.
- `apps/web/src/comparison.tsx`: comparison collection and results UI.
- Existing package indices, application composition, tests and styles receive
  additive changes only.

Code follows existing ESM `.js` imports, strict TypeScript, discriminated unions,
TypeBox `additionalProperties: false`, stable reason codes and Prettier style.

Example internal rule shape:

```ts
return {
  criterion: 'CUSTOMER_REVIEWS',
  outcome: signal === null ? 'NO_DATA' : compareReviewEvidence(signal, peers),
  confidence: signal === null ? 'LOW' : reviewEvidenceConfidence(signal),
  reasonCode:
    signal === null ? 'REVIEW_DATA_UNAVAILABLE' : 'REVIEW_EVIDENCE_COMPARED',
};
```

## 9. Commands

All executable verification runs on the server in Docker, not in the local
workspace.

```bash
docker build --target verification -t whatthemake-verification:<release> .
docker build --target runtime -t whatthemake-web:<release> .
docker compose -p whatthemake --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/current/.release.env \
  -f /srv/whatthemake/current/deploy/production/compose.yml ps
curl --fail --silent https://whatthemake.ru/api/v1/live
curl --fail --silent https://whatthemake.ru/api/v1/ready
```

Focused unit/contract tests are added to the existing `npm test` command. A
database-backed route integration test runs against the isolated server test DB.
Playwright covers two-slot, three-slot, partial-not-found, quick mode,
personalized mode, automatic external found/miss/unavailable fallback and
narrow/wide layouts.

## 10. Boundaries

### Always

- validate all request and repository data at boundaries;
- preserve exact `ProductVariant` identity and provenance;
- keep external discovery attributed, ephemeral and lower-trust than canonical
  catalogue identity;
- keep recommendation deterministic and versioned;
- include reviews as a real algorithm tier when trusted data exists;
- show missing review/price evidence explicitly;
- run contract, domain, integration, web, accessibility and production gates on
  the server before deployment;
- retain the previous immutable release for rollback.

### Ask first

- add a database migration or persistent comparison history;
- publish any external review aggregate;
- add a dependency;
- introduce a paid provider call;
- enable another discovery provider, arbitrary web search or persistent import;
- change the agreed public recommendation vocabulary.

### Never

- accept rating or review evidence from the comparison client;
- publish synthetic ratings as real data;
- mix family-level and variant-level reviews;
- let reviews, popularity or price override a hard constraint;
- expose a universal score, hidden composite score or safety percentage;
- infer medical suitability from claims, reviews or formula;
- send photos, secrets or user identifiers to comparison logs.
- let a client control the upstream origin/path, auto-publish an external
  candidate or present it as verified.

## 11. Success criteria

1. API accepts exactly 2–3 unique valid GTINs and a strict mascara brief.
2. Partial `NOT_FOUND` preserves successful slots and returns no winner.
3. Same input, catalog state, review signals and rules version produce bytewise
   equivalent semantic results.
4. Hard constraints always outrank review and claim evidence.
5. In unknown-goals mode, a strong fresh review fixture can differentiate two
   otherwise comparable slots; missing/tiny/stale samples cannot.
6. Production with no licensed review aggregate explicitly shows no review data
   and does not fabricate a winner from popularity.
7. UI supports two and three slots at 320 px and wide desktop without horizontal
   page overflow.
8. Every criterion exposes confidence, reason code and bounded evidence.
9. Existing catalog lookup, OCR, preferences and identity tests remain green.
10. Production health/readiness, asset loading and logs remain green after
    deployment; rollback to the previous release stays available.
11. A valid local miss automatically performs one deduplicated fixed-origin
    lookup and returns a strict `FOUND`, `NOT_FOUND` or `UNAVAILABLE` state.
12. External data cannot create a comparison winner, mutate the canonical
    catalogue or inject markup/URLs into the UI.

## 12. Out of scope

- review import, theme classification and WTM review publishing/moderation;
- licensed production review data;
- price capture and value ranking;
- saved comparison history and re-analysis;
- third-party product links, affiliate tracking or checkout;
- medical or universal safety evaluation;
- full single-product knowledge analysis not already present in the catalog.
- general search-engine crawling, marketplace scraping, remote image proxying,
  automatic external-to-canonical import and background catalogue enrichment.

## 13. Open questions

No blocking questions. Any production review publication, price ranking or
persistent history requires a separate reviewed slice.
