# Spec: mascara INCI benchmark gate v1

Дата: 2026-08-31
Статус: approved автономным execution mandate пользователя
Связанные задачи: D4–D6, Checkpoint D

## Проблема

Parser и canonicalizer имеют golden/fuzz tests, но Checkpoint D остаётся красным:
нет versioned контрольной выборки и числового gate `>=95%`. Переход к taxonomy,
rules и рекомендациям без такого gate может превратить ошибку OCR/normalization в
уверенно выглядящее объяснение.

## Цель

Создать воспроизводимый server-only benchmark, который:

1. использует зафиксированные noisy INCI строки exact mascara variants из уже
   разрешённого Open Beauty Facts seed;
2. содержит exhaustive ручную разметку каждого token/component, а не принимает
   parser output за truth;
3. измеряет ordered normalization accuracy и отдельно false resolution;
4. фиксирует dataset/parser/canonicalizer/dictionary versions;
5. завершает процесс ненулевым exit code при accuracy ниже `95%` либо при хотя
   бы одном false resolution;
6. печатает machine-readable JSON report для release evidence.

## Не цели

- реальный вызов Google Vision или DeepSeek;
- пользовательские/production photos;
- утверждение, что весь INCI каждой формулы проверен экспертом;
- knowledge/rule claims, safety score или рекомендация товара;
- подмена позднего J6 benchmark на 200+ карточек и реальные OCR images.

## Dataset

- Dataset id: `open-beauty-facts-mascara-inci-anchors`.
- Минимум: 20 exact variants и 100 вручную размеченных anchors.
- Product identity берётся только из
  `apps/server/seeds/mascara/seed.json`; family fallback запрещён.
- Поля sample: GTIN, product label, source URL, source last-modified time,
  retrieved time, raw INCI text и `qualityFlags`.
- Обязательная provenance: Open Beauty Facts, ODbL 1.0, attribution и license
  URL.
- Disclaimer/code/truncation остаются в raw text и помечаются. Они не
  исправляются скрыто.
- Candidate fetcher только помогает собрать данные. В golden corpus попадает
  лишь вручную проверенная разметка.
- Corpus содержит metadata первичного annotator, независимого reviewer и
  adjudication; annotator/reviewer должны различаться.

## Контракт anchor

Anchor задаёт:

- `sampleId` и стабильный `anchorId`;
- точные `tokenIndex` и `componentIndex`, поэтому повторы не смешиваются;
- ожидаемые lookup text, token kind и presence;
- ожидаемую presence (`DECLARED` или `MAY_CONTAIN`);
- discriminated outcome: `RESOLVED` с canonical name либо `UNRESOLVED` без
  canonical ingredient.

Каждый фактический parser component обязан иметь ровно один anchor; missing и
unexpected components проваливают gate. Corpus дополнительно обязан содержать
минимум 5 `UNRESOLVED`, 5 `MAY_CONTAIN`, 5 `CI_PIGMENT` anchors и минимум две
canonical identity, каждая из которых встречается в разных формулах под
разными lookup text. Такая stratum проверяет aliases честно; склеенные формулы
и ложные повторы внутри одного raw field не засчитываются.

Benchmark загружает тот же immutable JSON dictionary artifact, который
публикует production seed CLI. Версии/bytes совпадают; отдельной benchmark-only
копии нет. Этот dictionary содержит только имена/aliases и не становится
источником ingredient function facts.

## Метрики и gate

- `anchorAccuracy = correctAnchors / totalAnchors`.
- `expectedResolutionRate = expectedResolved / totalAnchors`; он также должен
  быть `>=95%`, чтобы corpus нельзя было «пройти» массовым expected unresolved.
- Anchor correct только при совпадении decision, canonical ingredient и
  presence. Отсутствующий/лишний/ambiguous result — ошибка.
- `falseResolutions`: expected `UNRESOLVED`, но получен `RESOLVED`.
- `parseRejects`: rejected source samples.
- `unexpectedComponents`: parser/canonicalizer создал component без anchor.
- Gate green, если одновременно:
  - samples `>=20`;
  - anchors `>=100`;
  - exhaustive coverage и обязательные strata выполнены;
  - anchor accuracy `>=0.95`;
  - expected resolution rate `>=0.95`;
  - false resolutions `=0`;
  - parse rejects `=0`.

Порог считается по anchors и честно называется engineering anchor gate.
Полный formula/OCR beta gate J6 остаётся отдельным обязательным этапом.

## Интерфейс

```text
npm run --silent benchmark:inci
  stdout: single JSON report
  exit 0: gate PASSED
  exit 1: gate FAILED или invalid corpus
```

Report содержит schema/dataset versions, все runtime versions, counts,
accuracy, failure reason codes и failed anchor IDs. Секреты, raw photos и
provider payloads в report не попадают.

## Проверка

- corpus boundary validation, duplicate IDs/coordinates и distinct reviewers;
- exhaustive component coverage и minimum strata;
- deterministic repeatability;
- deliberate wrong anchor делает gate красным;
- false resolution делает gate красным;
- version mismatch с production dictionary делает gate красным;
- threshold boundary `95%` проходит, ниже — нет;
- полный `typecheck/lint/test/build` и benchmark выполняются только на сервере;
- независимый review и simplify до production deploy.

## Последовательность после gate

`E2 mascara taxonomy -> E3 versioned rules -> E4 claims -> E5 single-product
analysis -> F reviews -> G comparison`.
