# Implementation Plan: What The Make

Статус: готов к инженерному ревью  
Основание: `docs/PRODUCT_SPEC.md`  
Принцип: вертикальные срезы, контракт до реализации, проверка после каждых 2–3 задач

## 1. Архитектурные решения

- Новый независимый TypeScript-монорепозиторий.
- Модульный монолит; микросервисы не используются до измеримой необходимости.
- Fastify API и React/Vite PWA с общими TypeBox-контрактами.
- Домен не зависит от HTTP, UI, PostgreSQL и внешних провайдеров.
- PostgreSQL хранит факты/права/jobs/cache; изображения — в защищённом файловом хранилище.
- Google Vision и DeepSeek подключаются через заменяемые adapters.
- Recommendation engine детерминирован; LLM не принимает финальное решение.
- Каждая категория добавляется отдельным вертикальным срезом.

## 2. Зависимости верхнего уровня

```text
Workspace
  ├─ Contracts ── API ── Web/Admin
  ├─ PostgreSQL ── Identity/Media/Catalog/Jobs
  ├─ Catalog ── OCR/INCI ── Knowledge ── Analysis
  ├─ Reviews ────────────────────────────┤
  └─ Preferences/Price ── Recommendation ── Comparison
                                             └─ Beta/Release
```

## 3. Фаза A — bootstrap и контракты

### A1. Инициализировать workspace

**Описание:** Создать Git-репозиторий, npm workspaces, `apps/*`, `packages/*`, strict TypeScript, ESM, lint/format/test/build scripts и базовые Docker-файлы.

**Приёмка:**

- структура соответствует spec;
- команды `build`, `typecheck`, `lint` и `test` существуют;
- секреты и runtime data исключены через `.gitignore`.

**Проверка:** `npm install`, `npm run typecheck`, `npm test`, `npm run build`.

**Зависимости:** нет.  
**Размер:** M, до 5 файлов конфигурации за один шаг; при необходимости разбить bootstrap на два коммита.

### A2. Создать общие API primitives

**Описание:** Определить TypeBox-схемы ID, timestamps, pagination, health/version и единого error envelope.

**Приёмка:**

- input/output контракты разделены;
- error codes стабильны и покрыты тестами;
- неизвестные поля и неверные enum отклоняются на границе.

**Проверка:** contract tests через `npm test -- contracts`.

**Зависимости:** A1.  
**Размер:** S, 2–3 файла.

### A3. Поднять Fastify composition root

**Описание:** Создать минимальный сервер с request ID, structured logging, security headers, liveness/readiness и единым error handler.

**Приёмка:**

- `/api/v1/live` не зависит от БД;
- `/api/v1/ready` отражает состояние зависимостей;
- internal error не раскрывает stack/secret.

**Проверка:** Fastify injection tests и `npm run build`.

**Зависимости:** A2.  
**Размер:** M, 3–5 файлов.

### A4. Добавить PostgreSQL и миграции

**Описание:** Pool, transaction helper, additive/idempotent migration runner и отдельная тестовая БД.

**Приёмка:**

- повторный запуск migration безопасен;
- readiness возвращает ошибку при недоступной БД;
- схема создаётся с нуля в CI.

**Проверка:** `npm run db:migrate`, integration tests, повторный `db:migrate`.

**Зависимости:** A1, A3.  
**Размер:** M, 4–5 файлов.

### Checkpoint A

- все базовые команды зелёные;
- dev Docker environment поднимается с чистой БД;
- архитектура и контракты проходят ручной ревью до предметного кода.

## 4. Фаза B — identity, preferences и media

### B1. Реализовать guest capability sessions

**Описание:** Создание гостевой сессии, защищённый token/cookie, владение ресурсами и явное удаление без автоматического expiry.

**Приёмка:**

- гость получает доступ только к своим ресурсам;
- токены не попадают в логи;
- удаление повторяемо и не раскрывает чужие ID.

**Проверка:** authz integration tests и security regression для IDOR.

**Зависимости:** A2, A4.  
**Размер:** M, 4–5 файлов.

### B2. Реализовать account session auth

**Описание:** Регистрация email/пароль без email verification, login/logout, стойкий password hash и server-side sessions.

**Приёмка:**

- cookie имеет `HttpOnly`, `Secure`, `SameSite`;
- ошибки входа не позволяют перечислять аккаунты;
- blocked/invalid sessions отклоняются сервером.

**Проверка:** unit/integration tests auth и cookie assertions.

**Зависимости:** A4.  
**Размер:** M, 4–5 файлов.

### B3. Добавить password reset

**Описание:** Одноразовый expiring token, request/confirm endpoints и email provider port.

**Приёмка:**

- token одноразовый и хранится безопасно;
- запрос не раскрывает существование email;
- rate limit применяется до отправки email.

**Проверка:** integration tests с fake email adapter.

**Зависимости:** B2.  
**Размер:** M, 3–5 файлов.

### B4. Реализовать preferences и mascara brief

**Описание:** Жёсткие ограничения, мягкие предпочтения, категорийный опрос и режим `UNKNOWN_GOALS`.

**Приёмка:**

- гость использует ephemeral snapshot;
- аккаунт сохраняет профиль;
- старый анализ хранит свою версию предпочтений.

**Проверка:** contract/domain tests и API integration tests.

**Зависимости:** B1, B2.  
**Размер:** M, 4–5 файлов.

### B5. Реализовать защищённое media storage

**Описание:** Media port, локальный adapter, metadata/ownership, upload limits, hash, authorized serving и до пяти фото на товар.

**Приёмка:**

- путь нельзя подменить пользовательским input;
- чужое фото недоступно;
- public directory не содержит uploads;
- base64 не сохраняется.

**Проверка:** traversal/IDOR/oversize tests и ручная проверка lifecycle файла.

**Зависимости:** B1, B2, A4.  
**Размер:** M, разбить upload и serving, если выходит за 5 файлов.

### B6. Добавить deletion jobs и recovery journal

**Описание:** Идемпотентное удаление БД/медиа, повтор после сбоя и journal частично завершённых операций.

**Приёмка:**

- повтор job безопасен;
- ресурс закрывается сразу, физическая очистка может завершиться позже;
- restart продолжает незавершённую работу.

**Проверка:** crash/retry integration tests.

**Зависимости:** B5.  
**Размер:** M, 4–5 файлов.

### Checkpoint B

- guest и account flows проходят end-to-end;
- перенос гостевой истории в аккаунт проверен;
- media authorization и deletion recovery зелёные;
- принятое бессрочное хранение гостей отражено в schema/metrics.

## 5. Фаза C — каталог mascara-first

### C1. Реализовать GTIN/EAN domain module

**Описание:** EAN-8, UPC-A, EAN-13, GTIN-14, normalization и checksum.

**Приёмка:** валидные форматы нормализуются; ошибочный checksum отклоняется; leading zeros не теряются.

**Проверка:** table-driven и property tests.

**Зависимости:** A1.  
**Размер:** S, 1–2 файла.

### C2. Создать product identity schema

**Описание:** `ProductFamily`, `ProductVariant`, barcode mapping, `FormulaRevision`, claims, provenance и status transitions.

**Приёмка:**

- family/variant нельзя перепутать типами/constraints;
- изменение INCI создаёт ревизию;
- GTIN uniqueness и variant conflict обрабатываются явно.

**Проверка:** migration + repository integration tests.

**Зависимости:** A4, C1.  
**Размер:** M, 4–5 файлов.

### C3. Сделать catalog lookup vertical slice

**Описание:** GTIN endpoint, repository и первая мобильная карточка известного варианта.

**Приёмка:** известный barcode открывает exact variant; неизвестный возвращает стабильный `NOT_FOUND` flow; response имеет provenance.

**Проверка:** contract/integration/Playwright happy path.

**Зависимости:** C2, A2.  
**Размер:** M, 4–5 файлов.

### C4. Добавить браузерный barcode scanner

**Описание:** Локальный ZXing bundle, native `getUserMedia`, ручной ввод и безопасный lifecycle потока.

**Приёмка:**

- кадры не отправляются стороннему scanner service;
- быстрый close не оставляет stream;
- работает fallback ручного ввода.

**Проверка:** browser source tests и Playwright с mocked media devices.

**Зависимости:** C1, C3.  
**Размер:** M, 3–5 файлов.

### C5. Создать unknown-product observation flow

**Описание:** Capture record, media roles, личное наблюдение и повторное использование гостем/аккаунтом.

**Приёмка:** наблюдение не публикуется глобально; ownership соблюдается; пять фото имеют отдельные роли.

**Проверка:** API integration + guest/account Playwright flow.

**Зависимости:** B5, C2.  
**Размер:** M, 4–5 файлов.

### C6. Реализовать catalog promotion

**Описание:** Fingerprint, подтверждение двумя разными аккаунтами либо admin moderation.

**Приёмка:** два токена одного аккаунта не считаются двумя подтверждениями; гость не публикует глобально; conflict уходит в moderation.

**Проверка:** race/security integration tests.

**Зависимости:** B2, C5.  
**Размер:** M, 4–5 файлов.

### C7. Реализовать seed import

**Описание:** Версионированный импорт 200–300 тушей, dry-run, quarantine, conflict report и audit.

**Приёмка:** повторный импорт идемпотентен; данные с неясными правами блокируются; rollback восстанавливает предыдущую публикацию.

**Проверка:** fixture import дважды, dry-run diff и rollback test.

**Зависимости:** C2, admin audit primitive из A4.  
**Размер:** M, разбить parser и publish на отдельные задачи при необходимости.

### Checkpoint C

- известный GTIN не требует OCR;
- неизвестный товар сохраняется приватно;
- formula revisions и promotion races проверены;
- seed import воспроизводим и аудируем.

## 6. Фаза D — OCR и INCI

### D1. Создать provider ports и Google Vision adapter

**Описание:** OCR contract, strict response validation, timeout/abort, telemetry и fake adapter.

**Приёмка:** malformed provider response отклоняется; secret не логируется; failure имеет стабильный error code.

**Проверка:** fixture/timeout/abort tests.

**Зависимости:** A2, B5.  
**Размер:** M, 4–5 файлов.

### D2. Добавить work queue и backpressure

**Описание:** Concurrency/pending limits, wait timeout и graceful shutdown для OCR/import jobs.

**Приёмка:** перегрузка возвращает retryable error; shutdown дожидается безопасной границы; отменённый request прекращает provider call.

**Проверка:** concurrency tests и shutdown smoke test.

**Зависимости:** D1.  
**Размер:** S/M, 2–4 файла.

### D3. Реализовать provider cache

**Описание:** inflight, L1 и PostgreSQL L2; cache keys с версиями; успешные ответы only.

**Приёмка:** restart сохраняет L2 hit; failure не кэшируется; cache error не ломает provider fallback.

**Проверка:** duplicate/race/restart integration tests.

**Зависимости:** A4, D1.  
**Размер:** M, 4–5 файлов.

### D4. Реализовать INCI tokenizer/parser

**Описание:** Разделители, скобки, OCR noise, `CI` pigments, `may contain`/`±` и source spans.

**Приёмка:** порядок сохраняется; uncertain tokens не исчезают; parser не выдумывает concentration.

**Проверка:** golden corpus + fuzz/property tests.

**Зависимости:** A1.  
**Размер:** M, 3–5 файлов.

### D5. Добавить canonicalization и aliases

**Описание:** Canonical ingredient IDs, aliases, normalization confidence и unresolved tokens.

**Приёмка:** alias traceable; неоднозначность не разрешается молча; версия словаря входит в snapshot.

**Проверка:** corpus tests и migration/repository tests.

**Зависимости:** D4, A4.  
**Размер:** M, 4–5 файлов.

### D6. Сделать user correction flow

**Описание:** Просмотр OCR/INCI sources, ручное исправление и сохранение correction evidence.

**Приёмка:** original immutable; correction имеет автора/время; re-analysis использует явную выбранную ревизию.

**Проверка:** Playwright capture/correct/re-run и snapshot tests.

**Зависимости:** C5, D1, D5.  
**Размер:** M, 4–5 файлов.

### D7. Создать DeepSeek adapter

**Описание:** LLM port, strict output schema, sanitization, prompt version, timeout и deterministic fallback.

**Приёмка:** prompt-like input не меняет инструкции; invalid answer отвергается; LLM output не создаёт evidence.

**Проверка:** malicious fixtures, schema tests и disabled-provider flow.

**Решение 2026-08-27:** adapter использует официальный DeepSeek Responses API с `deepseek-v4-flash` и `json_schema`; локальная runtime/semantic validation остаётся обязательной. Provider выключен до явной конфигурации секрета и consumer flow. Результат типизирован как недоверенный draft либо пустой deterministic fallback, но не evidence.

**Зависимости:** A2, D3.  
**Размер:** M, 3–5 файлов.

### Checkpoint D

- golden INCI normalization достигает ≥95%; либо gate остаётся красным;
- исходный OCR и corrections различимы;
- provider/cache/queue telemetry доступна;
- Vision/DeepSeek failure деградирует безопасно.

**Проверка 2026-08-31:** gate зелёный. Versioned mascara corpus содержит 20
независимо проверенных samples и 455 исчерпывающих anchors. Серверный Docker
gate дал 455/455 (100%), expected resolution 98,90%, false resolutions 0,
unexpected components 0 и parse rejections 0. Boundary tests подтверждают:
ровно 95% проходит, ниже 95% блокируется; duplicate GTIN, нестрогий UTF-8 и
несовпадающий checksum блокируются. Полный контур: 89 unit tests и 23/23
PostgreSQL integration tests, fail/skip 0 в DB-наборе. Original/corrections
разделены; provider/cache/queue telemetry и безопасная деградация
Vision/DeepSeek проверены.

## 7. Фаза E — знания и одиночный разбор

### E1. Создать evidence-backed knowledge model

**Описание:** Ingredient functions, evidence types, jurisdiction, checkedAt, source URL, confidence и publish status.

**Приёмка:** опубликованный факт не существует без evidence; конфликт источников сохраняется; изменения версионируются.

**Проверка:** domain constraints + repository integration tests.

**Зависимости:** A4, D5.  
**Размер:** M, 4–5 файлов.

**Решение 2026-08-27:** знания хранятся immutable snapshots с явной версией и
ссылкой на предыдущий snapshot. Ingredient-function fact имеет jurisdiction и
confidence; evidence — тип, source URL, checkedAt и stance
`SUPPORTS`/`CONTRADICTS`. Publication без supporting evidence запрещена domain
contract и PostgreSQL trigger; конфликтующие источники сохраняются.

### E2. Описать mascara taxonomy

**Описание:** Воски, эмоленты, плёнкообразователи, волокна, pigments, preservatives, fragrances и category claims.

**Приёмка:** каждая группа имеет простое объяснение; food terms отсутствуют; unsupported property не выводится.

**Проверка:** curated fixtures и prohibited-word regression tests.

**Зависимости:** E1.  
**Размер:** M, данные разбить на несколько небольших seed-файлов.

### E3. Создать versioned rule engine

**Описание:** Детерминированные category rules, confidence, evidence refs и runtime kill switch.

**Приёмка:** одинаковый snapshot/versions даёт одинаковый результат; отключённое правило не требует deploy; absolute safety wording запрещён.

**Проверка:** golden rule tests и kill-switch integration test.

**Зависимости:** E1, E2.  
**Размер:** M, 4–5 файлов.

### E4. Реализовать claims extraction

**Описание:** Manufacturer claims из OCR/каталога с отдельным типом происхождения; formula inference хранится отдельно.

**Приёмка:** claim не отображается как доказанный performance fact; источник и confidence видимы.

**Проверка:** fixtures RU claims и UI snapshot.

**Зависимости:** D1, D7, E3.  
**Размер:** M, 3–5 файлов.

### E5. Сделать single-product analysis vertical slice

**Описание:** Analysis snapshot, API и мобильная карточка с INCI groups, claims, uncertainty и CTA compare.

**Приёмка:** known и unknown product paths сходятся в один контракт; каждый вывод traceable; без LLM доступен базовый результат.

**Проверка:** domain/integration/Playwright end-to-end.

**Зависимости:** C3/C5, D6, E3, E4, B4.  
**Размер:** разбить API и UI на два последовательных M-task, если превышает 5 файлов.

### E6. Добавить report-an-error flow

**Описание:** Пользовательский report связывается со snapshot, rule/evidence versions и moderation queue.

**Приёмка:** report не раскрывает приватное фото неавторизованному admin; duplicate reports агрегируются.

**Проверка:** API/authz tests и admin fixture.

**Зависимости:** E5.  
**Размер:** S/M, 2–4 файла.

### Checkpoint E

- одиночный разбор работает end-to-end;
- нет universal score и медицинских утверждений;
- каждый значимый вывод имеет evidence/confidence;
- rule kill switch и error report проверены.

## 8. Фаза F — отзывы

### F1. Определить review source contracts

**Описание:** Source identity, permitted fields, rights metadata, freshness, product matching и import audit.

**Приёмка:** неизвестное право блокирует publish; connector не может писать прямо в canonical tables.

**Проверка:** contract tests с allow/deny fixtures.

**Зависимости:** A2, C2.  
**Размер:** S/M, 2–4 файла.

### F2. Реализовать controlled aggregate import

**Описание:** Rating/count/distribution/themes import с dry-run, quarantine и idempotent publish.

**Приёмка:** повтор import не удваивает данные; source/asOf обязательны; invalid rows не частично публикуются.

**Проверка:** import integration tests и dry-run report.

**Зависимости:** F1, C7.  
**Размер:** M, 4–5 файлов.

### F3. Реализовать strict product matching

**Описание:** GTIN + brand/name/variant; family-level data остаётся family-level.

**Приёмка:** ambiguous match попадает в quarantine; waterproof/regular и shade variants не смешиваются.

**Проверка:** adversarial matching corpus.

**Зависимости:** C2, F2.  
**Размер:** M, 3–5 файлов.

### F4. Реализовать review theme aggregation

**Описание:** DeepSeek classification по разрешённому тексту и детерминированный подсчёт статистики.

**Приёмка:** LLM не считает totals/weights; тема хранит sample size/source/asOf/confidence; invalid output ignored.

**Проверка:** fixed review fixtures и repeatability tests.

**Зависимости:** D7, F2, F3.  
**Размер:** M, 4–5 файлов.

### F5. Показать review summary

**Описание:** API/UI рейтинга, объёма, свежести, themes и разрешённых links/examples.

**Приёмка:** external и WTM reviews различимы; отсутствие данных не выглядит как нулевой рейтинг.

**Проверка:** contract/UI/Playwright tests.

**Зависимости:** F4, E5.  
**Размер:** M, 4–5 файлов.

### F6. Добавить собственные отзывы WTM

**Описание:** Один active review на account+variant, edit history и отсутствие email-verification requirement.

**Приёмка:** guest не публикует; duplicate active review невозможен; edit не стирает audit history.

**Проверка:** database uniqueness/race/API tests.

**Зависимости:** B2, C2.  
**Размер:** M, 4–5 файлов.

### F7. Добавить anti-abuse и moderation

**Описание:** Rate limits, duplicate-text signals, suspicious weight, admin decisions и audit.

**Приёмка:** moderation не удаляет историю; blocked review не влияет на aggregate; admin action traceable.

**Проверка:** abuse fixtures, role/authz tests и audit assertions.

**Зависимости:** F6.  
**Размер:** M, 4–5 файлов.

### Checkpoint F

- controlled import не использует scraping;
- variant matching проходит adversarial corpus;
- external и WTM signals разделены;
- review themes показывают выборку и свежесть;
- abuse controls включены до публичного review endpoint.

## 9. Фаза G — цена и сравнение

### G1. Реализовать price observations

**Описание:** Ручная цена, распознанный ценник и внешняя цена с source/asOf/basis.

**Приёмка:** валюты/основания валидируются; stale external price маркируется; несопоставимые цены не ранжируются.

**Проверка:** domain/contract tests и price-tag fixture.

**Зависимости:** D1, C2.  
**Размер:** M, 3–5 файлов.

### G2. Определить comparison contracts

**Описание:** Два обязательных и третий optional slot, exact variants, frozen preference snapshot и per-slot evidence.

**Приёмка:** одинаковые названия не смешивают слоты; >3 items отклоняются; partial failure описана в контракте.

**Проверка:** TypeBox contract tests.

**Зависимости:** A2, E5, F5, G1.  
**Размер:** S/M, 2–4 файла.

### G3. Реализовать personalized recommender

**Описание:** Иерархия constraints → goals → formula/claims → reviews → value → tie-breaker.

**Приёмка:** hard constraint не перебивается rating/price; каждый criterion traceable; результат детерминирован.

**Проверка:** golden pair tests и counterexample regression suite.

**Зависимости:** B4, E3, F4, G1, G2.  
**Размер:** M, 3–5 файлов.

### G4. Реализовать universal recommender

**Описание:** Повышенный вес качественных review signals при неизвестных целях.

**Приёмка:** sample size/freshness влияют; нулевые/отсутствующие reviews не выигрывают; hard constraints сохраняются.

**Проверка:** golden universal-mode tests.

**Зависимости:** G3.  
**Размер:** S/M, 2–4 файла.

### G5. Реализовать uncertainty и no-winner

**Описание:** Confidence propagation, близкие результаты, insufficient/ambiguous data и стабильные reason codes.

**Приёмка:** система не выбирает победителя при low identity confidence; UI получает понятную причину.

**Проверка:** boundary/golden tests.

**Зависимости:** G3, G4.  
**Размер:** S/M, 2–4 файла.

### G6. Сделать comparison vertical slice

**Описание:** API, мобильная таблица критериев, recommendation, trade-offs, confidence и fullscreen photos.

**Приёмка:** 2–3 slots; responsive mobile layout; partial product failure не стирает успешные данные.

**Проверка:** integration + Playwright на narrow/wide viewports.

**Зависимости:** G2–G5.  
**Размер:** разбить server/UI на два M-task.

### G7. Добавить history и re-analysis

**Описание:** Immutable analysis/comparison snapshots, personal history, guest transfer и explicit re-run.

**Приёмка:** старый результат не меняется после rule update; re-run создаёт новую запись; ownership соблюдается.

**Проверка:** version/history integration + Playwright.

**Зависимости:** E5, G6, B1/B2.  
**Размер:** M, 4–5 файлов.

### Checkpoint G

- benchmark pairs ≥90% explainable result/no-winner;
- universal mode использует отзывы, personalized mode — цели;
- price basis и confidence видимы;
- history/version reproducibility проверена.

## 10. Фаза H — PWA и UX hardening

### H1. Создать design system и responsive shell

**Описание:** WTM identity, tokens, stable RU keys, local SVG icons и основные layouts.

**Приёмка:** нет platform emoji; узкая/широкая вёрстка; пользовательский текст не проходит через i18n.

**Проверка:** visual snapshots и manual review.

**Зависимости:** A1.  
**Размер:** M, 4–5 файлов.

### H2. Завершить camera/upload UX

**Описание:** Camera permissions, landscape, torch capability, file upload, paste/drag-drop и client compression.

**Приёмка:** iOS/Android lifecycle корректен; пять фото; stream закрывается при каждом выходе.

**Проверка:** mocked media tests + реальные device smoke checks.

**Зависимости:** B5, C4, D6, H1.  
**Размер:** M, 4–5 файлов.

### H3. Добавить installable offline shell

**Описание:** Manifest/service worker/static shell и явное offline state.

**Приёмка:** приложение устанавливается; offline не показывает устаревший анализ как новый; сеть явно требуется для providers/reviews.

**Проверка:** Playwright offline test и Lighthouse PWA checks.

**Зависимости:** H1.  
**Размер:** S/M, 2–4 файла.

### H4. Провести accessibility pass

**Описание:** Semantic controls, keyboard, focus, contrast, reduced motion и screen-reader labels.

**Приёмка:** critical flow работает с клавиатуры; modals возвращают focus; camera actions имеют labels.

**Проверка:** axe/Playwright + manual keyboard pass.

**Зависимости:** H1, G6.  
**Размер:** серия S-task по экрану, не один XL-task.

### H5. Реализовать safe share card

**Описание:** Share result без приватных фото/ограничений по умолчанию.

**Приёмка:** пользователь явно выбирает включаемое фото; secrets/capabilities отсутствуют в URL/metadata.

**Проверка:** privacy snapshot tests и manual share check.

**Зависимости:** E5, G6, H1.  
**Размер:** S/M, 2–4 файла.

### Checkpoint H

- iPhone, Android, Windows smoke matrix;
- portrait/landscape и narrow/wide;
- camera/barcode streams не протекают;
- accessibility и offline states проверены.

## 11. Фаза I — admin и operations

### I1. Реализовать admin authorization и audit

**Описание:** Server-side roles, admin route plugin и append-only audit events.

**Приёмка:** UI check не считается защитой; каждый mutation имеет actor/requestId/reason; tampering detectable.

**Проверка:** role matrix и audit integration tests.

**Зависимости:** B2, A4.  
**Размер:** M, 4–5 файлов.

### I2. Создать archive/quality dashboard

**Описание:** Analysis snapshots, users/guests, OCR/provider timings, unresolved INCI и no-winner metrics.

**Приёмка:** private media требует отдельной authz check; exports не содержат base64/secrets/cookies.

**Проверка:** admin API/Playwright и export redaction tests.

**Зависимости:** I1, E5, G7.  
**Размер:** разбить API/UI на два M-task.

### I3. Создать catalog moderation tools

**Описание:** Merge/split variants, observation approval, formula revision review и conflict queue.

**Приёмка:** операция previewable; destructive merge требует confirmation; все изменения аудируются.

**Проверка:** catalog regression + admin Playwright.

**Зависимости:** I1, C6, C7.  
**Размер:** несколько M-task по операции.

### I4. Создать knowledge/rule console

**Описание:** Evidence CRUD, staged publish, version history и kill switch.

**Приёмка:** unpublished data не влияет на результат; rollback возвращает прошлую версию; evidence required.

**Проверка:** publish/rollback integration tests.

**Зависимости:** I1, E1, E3.  
**Размер:** разбить API/UI на два M-task.

### I5. Создать review/import moderation

**Описание:** Import status/quarantine, own-review moderation, suspicious signals и aggregate rebuild.

**Приёмка:** rejected review перестаёт влиять на aggregate; rebuild repeatable; источник/право видимы.

**Проверка:** moderation/import regression tests.

**Зависимости:** I1, F2, F7.  
**Размер:** M, 4–5 файлов.

### I6. Создать privacy operations

**Описание:** Delete account/history/guest data, file jobs, status и recovery UI.

**Приёмка:** повтор безопасен; deleted resource immediately inaccessible; pending cleanup наблюдаем.

**Проверка:** end-to-end deletion/crash recovery.

**Зависимости:** I1, B6, G7.  
**Размер:** M, 4–5 файлов.

### Checkpoint I

- admin role matrix зелёная;
- все mutations аудируются;
- catalog/knowledge/review rollback проверен;
- privacy delete recovery проходит после simulated crash.

## 12. Фаза J — security, performance и release

### J1. Провести threat model и security review

**Описание:** Authz/IDOR, CSRF, XSS, SSRF, traversal, upload bombs, prompt injection, provider poisoning и secrets.

**Приёмка:** high-confidence findings исправлены; regression tests добавлены; accepted risks документированы.

**Проверка:** security suite и независимый diff review перед merge.

**Зависимости:** B–I завершены.  
**Размер:** review + отдельные S/M fixes.

### J2. Провести load/cost tests

**Описание:** Cached lookup, new OCR, comparison, queues, cache hit rate и provider budgets.

**Приёмка:** catalog ≤2s p95, OCR ≤15s p95 на согласованном профиле; overload деградирует предсказуемо.

**Проверка:** repeatable load script и сохранённый report.

**Зависимости:** D3, G6, I2.  
**Размер:** M, 3–5 файлов/scripts.

### J3. Настроить backup/restore

**Описание:** PostgreSQL + protected media backup, retention, integrity check и restore drill.

**Приёмка:** RPO/RTO зафиксированы; clean environment восстанавливается; секреты backup защищены.

**Проверка:** документированный restore drill.

**Зависимости:** A4, B5.  
**Размер:** M, scripts/docs/config.

### J4. Собрать production image

**Описание:** Multi-stage Docker, non-root app process, immutable tag, health/readiness и graceful shutdown.

**Приёмка:** image не содержит dev secrets; migration выполняется контролируемо; rollback image сохранён.

**Проверка:** local compose release smoke test.

**Зависимости:** J1–J3.  
**Размер:** M, 3–5 files.

### J5. Подготовить isolated deployment

**Описание:** `whatthemake.ru`, отдельная БД, volume, env, Docker network и reverse-proxy HTTPS на существующем сервере.

**Приёмка:** WTM restart/deploy не затрагивает CLEAR; application port не публичен; readiness подключён.

**Проверка:** production-like smoke + rollback rehearsal.

**Зависимости:** J4.  
**Размер:** M, production mutation только после отдельного разрешения.

### J6. Выполнить benchmark gate

**Описание:** 200+ карточек, OCR corpus, rule claims и comparison pairs.

**Приёмка:** OCR ≥95%; explainable/no-winner ≥90%; unsupported absolute claims = 0 в проверенной выборке.

**Проверка:** versioned benchmark report.

**Зависимости:** C7, D6, E5, F5, G6.  
**Размер:** dataset/task batches.

### J7. Провести закрытую beta

**Описание:** 50–100 пользователей, feedback capture, defect triage, metrics и rollback triggers.

**Приёмка:** helpfulness ≥80%; privacy/security incidents закрыты; blocking defects отсутствуют.

**Проверка:** beta report и go/no-go review.

**Зависимости:** J5, J6.  
**Размер:** операционный этап.

### J8. Выпустить limited public mascara-first

**Описание:** Staged traffic, monitoring, support path и post-launch review.

**Приёмка:** SLO/quality gates держатся; rollback доступен; следующая категория не начинается до review.

**Проверка:** release checklist и 24/72-hour health review.

**Зависимости:** J7.  
**Размер:** операционный этап.

## 13. Расширение категорий

Для каждой следующей категории повторяется mini-cycle:

1. vocabulary/taxonomy и evidence;
2. category brief;
3. rule module;
4. seed/benchmark;
5. analysis/comparison UI;
6. admin/quality metrics;
7. limited release gate.

Контракты расширяются только additive optional fields и category discriminators.

## 14. Параллелизация

После фиксации контрактов безопасно параллелить:

- UI shell и domain unit tests;
- knowledge data preparation и media/auth infrastructure;
- admin read-only screens и уже готовые API;
- benchmark dataset и provider adapters;
- documentation и accessibility review.

Последовательно выполняются:

- DB migrations/shared schema changes;
- product identity до matching/import;
- INCI normalization до knowledge rules;
- review matching до aggregation;
- recommender contracts до API/UI;
- release image до production migration/deploy.

## 15. Риски и компенсации

| Риск                                      |         Уровень | Компенсация                                                                         |
| ----------------------------------------- | --------------: | ----------------------------------------------------------------------------------- |
| Нет свободного review API для всего рынка |         высокий | разрешённый controlled import, provenance, адаптеры                                 |
| Нет внешнего эксперта                     |         высокий | консервативные rules, двойная внутренняя проверка, beta, kill switch                |
| Бессрочные guest media                    |         высокий | capability deletion, quotas/metrics, protected storage, отдельный future review     |
| Root/password SSH остаётся                |     критический | не хранить credential, отдельное разрешение на SSH/deploy, audit production actions |
| Email не подтверждается                   | средний/высокий | rate limits, lower review weight, duplicate signals, moderation                     |
| Variant mismatch                          |         высокий | GTIN+fingerprint, quarantine, no-winner                                             |
| LLM/provider poisoning                    |         высокий | strict schemas, untrusted-input handling, evidence gate                             |
| Provider cost/latency                     |         средний | queue/backpressure, inflight/L1/L2, budgets, telemetry                              |
| Один физический сервер                    |         средний | isolation, backups, restore drills, immutable rollback                              |

## 16. Definition of Done для каждой задачи

- acceptance criteria выполнены;
- unit/contract/integration tests добавлены по риску;
- `npm run typecheck`, `npm run lint`, `npm test` проходят;
- build проходит;
- spec/contract обновлены при изменении решения;
- нет секретов и чужих изменений;
- задача не превышает примерно 5 файлов; иначе предварительно разбита;
- после реализации выполнен review перед merge.

## 17. Первый разрешаемый implementation slice

Начинать реализацию следует с A1–A4. До этого требуется отдельное явное подтверждение начала кодирования. Production/SSH действия не входят в этот slice и всегда требуют отдельной команды пользователя.
