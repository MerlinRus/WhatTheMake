# What The Make

What The Make helps shoppers understand and compare decorative cosmetics. First vertical slice: mascara.

Product decisions live in [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md). Implementation order lives in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

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
