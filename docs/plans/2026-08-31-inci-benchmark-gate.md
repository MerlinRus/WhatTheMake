# Plan: mascara INCI benchmark gate v1

Дата: 2026-08-31
Spec: `docs/specs/2026-08-31-inci-benchmark-gate.md`

## 1. Corpus acquisition

- Добавить bounded Open Beauty Facts candidate fetcher: exact GTINs из seed,
  strict response validation, proper User-Agent, ограниченная concurrency.
- На сервере получить candidates и вручную выбрать минимум 20 samples.
- Зафиксировать ODbL provenance, raw text, quality flags и exhaustive anchors.
- Провести независимую вторую проверку и сохранить reviewer/adjudication
  metadata.

Проверка: invalid/missing API rows не попадают в output; production DB и
providers не затрагиваются.

## 2. Contract-first evaluator

- Добавить pure domain types/evaluator для corpus и report.
- Сопоставлять anchors точными token/component coordinates.
- Не разрешать duplicate IDs/coordinates, unknown sample references,
  неполное component coverage и недостаточные negative strata.
- Gate: samples/anchors/accuracy/false-resolution/parse-reject conditions.

Проверка: focused unit tests, включая deliberate failures и determinism.

## 3. Shared dictionary publish path

- Вынести dictionary в один immutable versioned JSON artifact.
- Добавить idempotent dry-run/publish CLI и transaction repository.
- Benchmark и production publish читают один artifact и проверяют одну версию.

Проверка: integration test publish/idempotency/version conflict; runtime
repository после publish возвращает тот же version/content.

## 4. CLI и scripts

- Добавить `npm run benchmark:inci`; evidence command использует `--silent`.
- Валидировать JSON boundary до domain evaluator.
- Печатать один JSON report; exit code отражает gate.
- Включить benchmark unit test в основной `npm test`.

Проверка: server-only `typecheck`, `lint`, `test`, `build`, два одинаковых
benchmark run.

## 5. Review и release

- Независимый standards/spec review, security review и simplification pass.
- Исправить findings, повторить server verification.
- Commit/push, immutable image, readiness/health/build SHA, rollback retention.

## 6. Следующий checkpoint

После зелёного engineering gate перейти к E2/E3. Если corpus не достигает
минимума либо gate красный, downstream knowledge/rule work не начинается.
