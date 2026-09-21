# GTIN quality: evidence and limits

## Current coverage audit (2026-09-20)

- `packages/domain/test/gtin.test.ts`: code lengths, checksum, canonical identity.
- `packages/infrastructure/test/product-discovery-provider.test.ts`: constructed
  HTTP responses, exact returned-code validation, category rejection, HTTP failure,
  deadline, unsafe text/size limits, cache/deduplication.
- `packages/infrastructure/test/cached-product-discovery-provider.test.ts`:
  deterministic clocks, six-hour hits/fifteen-minute misses, LRU bounds, canonical
  GTIN aliases, mutable result isolation, concurrency, failure non-caching.
- `apps/server/test/discovery-comparison.test.ts`: application state mapping and
  refusal to promote external candidates into independently confirmed identity.
- The existing INCI benchmark and imported catalogue share Open Beauty Facts
  provenance. Neither measures independent internet GTIN discovery accuracy.
- No stratified live GTIN benchmark, source-conflict adjudication benchmark, or
  production cold/warm latency distribution is established by those tests. The
  five-millisecond mocked abort test proves timeout mapping, not real latency.

## Independent labels, deliberately small

`holdout-v1.json` records three GTIN/title pairs from manufacturer-labelled cosnova
leaflets on dm's retailer document host. The source URLs and page are recorded
per item. They were read independently of Open Beauty Facts and are absent from
the imported mascara seed and existing benchmark at collection time. Category is
annotated from the explicit title: two mascaras, one brow pencil. Only identity
facts are transcribed; no formula, photos, descriptions, reviews or ratings copied.
The documents name cosnova, but are not hosted on cosnova's own domain.

This is an independent-source seed holdout, not a statistically representative,
blind or human-adjudicated benchmark. The author selected the cases and read the
implementation; all products share one brand/manufacturer and European market.
Human review is still pending. Do not use the three cases to claim a precision
percentage, Russian shop coverage, or exact shade/pack/formula identification.
Future imports must preserve their exclusion or replace the holdout; the runner
fails if their canonical GTINs enter the seed.

## Offline harness

Run **on the server**, after dependencies/domain build are available:

```sh
node --import tsx tools/gtin-quality-benchmark.ts
```

The runner injects hand-built Open Beauty Facts-shaped responses into the actual
provider. It performs no network fetch. It checks exact identity and zero-padded
GTIN equivalence, a brow product incorrectly tagged as mascara, conflicting
returned GTIN, provider-scoped miss, quota failure, upstream failure and deadline.
This is adapter regression coverage using independent identity labels, **not** a
replay of actual third-party responses. Misses are simulated for a known existing
product: NOT_FOUND only describes a provider response, never global nonexistence.

The JSON report explicitly leaves live precision, coverage and production p95
null. Per-case processing timings describe this local mocked execution only.
Do not aggregate the positive and synthetic negative cases as live accuracy.
Conflicting GTIN rejection does not prove detection of two sources disagreeing on
the product behind the same GTIN; that workflow remains unimplemented/unmeasured.

## Next real measurement

Before a live quality claim, freeze a larger separately reviewed set (e.g. 100+
products across brands, countries, shades, pack sizes, primer/brow negatives).
Record manufacturer/physical-package evidence independently from search sources.
Include known products absent from the production catalogue; keep pure synthetic
HTTP failures outside the accuracy denominator. An upstream miss cannot label a
GTIN as globally nonexistent.

Capture normalized requested/returned GTIN, exact identity fields, source URL,
source retrieval date, outcome and elapsed time for each actual provider call.
Report exact-match precision separately from candidate recall/abstention,
unsupported-category false accepts, conflicts, and provider availability.
Report cold and warm p50/p95, sample size, request budget and timeout rate; retain
failures rather than dropping slow requests. Do not add model guesses as labels.

## Candidate no-key source: UPCitemdb

Official [plan documentation](https://www.upcitemdb.com/wp/docs/main/development/plan/)
and [getting started guide](https://www.upcitemdb.com/wp/docs/main/development/getting-started/)
document a free exact-code API, no signup/key:
`https://api.upcitemdb.com/prod/trial/lookup?upc=...`.
Documented limits: 100 combined requests/day, six lookups/minute, one connection;
use explicit daily budget and respect Retry-After/rate headers. Do not use search
engine scraping or a paid endpoint as a fallback.

Its [response documentation](https://www.upcitemdb.com/wp/docs/main/development/responses/)
provides EAN/title/brand/category fields and distinguishes 429/5xx from a miss.
It also distinguishes trade-item EAN from optional GTIN-14 packaging levels:
never strip a nonzero indicator digit to force a match. Returned exact canonical
code must match the request; conflicting codes or multiple identities need a
conflict/uncertain result. Marketplace titles are candidate evidence, not
manufacturer verification or proof of formula, price freshness or buyer ratings.

The [provider terms](https://www.upcitemdb.com/terms) disclaim result accuracy and
availability. This is an integration candidate, not an endorsement or a claim of
commercial reuse rights beyond the documented service. The main task should
review deployment use and data retention before activation. No account, payment,
provider integration, live API probe, or catalogue import was performed here.
