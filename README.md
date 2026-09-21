# What The Make

What The Make helps shoppers understand and compare decorative cosmetics. First vertical slice: mascara.

Product decisions live in [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md). Implementation order lives in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Product workflows

- Exact-GTIN catalogue lookup, then attributed Open Beauty Facts/UPCitemdb candidates.
  A candidate is not a verified formula or shade. A missing code can still be
  analysed privately from packaging and manually corrected OCR.
- Owned immutable product snapshots, ingredient-name resolution, explicitly
  evidenced ingredient functions, and two/three-slot public/private comparison.
  Hard constraints cannot be overridden by claims, price or reviews.
- Account preferences, guest/account history, offline recovery code, deletion,
  and moderated buyer reviews. Purchases and email are not verified.
- Review weights account for sample size, source quality and aggregate freshness.
  Topic counts describe words in displayed reviews, not sentiment or performance.

No universal product/safety score, fabricated reviews or model-invented product
facts. DeepSeek is configured but is not a customer-path recommendation engine.
Production evidence and limitations are recorded in
[`docs/reviews/2026-09-20-private-workflows.md`](docs/reviews/2026-09-20-private-workflows.md).

## Local development

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Production operations are documented in
[`deploy/production/RUNBOOK.md`](deploy/production/RUNBOOK.md).
The current project workflow runs builds and tests in isolated containers on the
server, not on the developer's machine. Use `deploy/production/verify-release.sh`
for the complete build, integration, mobile-browser and private-API gates.
