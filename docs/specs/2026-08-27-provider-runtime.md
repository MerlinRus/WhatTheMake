# Spec: runtime-подключение Google Vision и DeepSeek

## Предположения

1. Google Vision становится пользовательской функцией: явное OCR фото с ролью
   `INGREDIENTS` внутри принадлежащего пользователю наблюдения.
2. OCR запускается кнопкой, не автоматически после загрузки: пользователь
   контролирует расход API и выбирает подходящее фото.
3. Успешный OCR сохраняется как неизменяемая исходная INCI-редакция с
   `mediaAssetId`, provider ID/version и SHA-256 текста.
4. Существующий ручной текст не перезаписывается. Повтор идентичного OCR
   идемпотентно возвращает сохранённую редакцию.
5. DeepSeek подключается к production config и создаётся при старте, но не
   анализирует сырой INCI: для него ещё нет evidence-backed consumer flow.
   Первый пользовательский вызов DeepSeek появится в E4 для ограниченной
   классификации разрешённых claims/review-текстов.
6. Недоступность внешнего провайдера не раскрывает его ответ или секрет и не
   удаляет фото/ручной текст.

## Цель

Завершить отсутствующий runtime-срез фазы D: пользователь загружает фото состава,
явно запускает Google Vision, проверяет распознанный текст, при необходимости
исправляет его и запускает детерминированный INCI-парсер.

DeepSeek должен быть безопасно сконфигурирован и валидирован при старте, но не
становится источником фактов и не вызывается без bounded consumer.

## Технологии

- Node.js 24, TypeScript, Fastify, TypeBox.
- React/Vite.
- PostgreSQL L2 OCR cache, in-memory L1/inflight deduplication.
- Google Vision `DOCUMENT_TEXT_DETECTION`.
- DeepSeek Responses API через существующий strict adapter.
- Docker Compose, immutable production release.

## Контракт

Новый endpoint:

`POST /api/v1/product-observations/:observationId/inci-ocr`

JSON:

```json
{ "mediaAssetId": "uuid" }
```

Ответ `200/201` использует существующий
`CreateProductObservationInciRevisionResponseSchema`.

Проверки:

- активная guest/account session;
- same-origin JSON;
- observation принадлежит сессии;
- asset принадлежит той же media collection;
- role строго `INGREDIENTS`;
- rate limit;
- request abort передаётся queue/provider;
- provider failures переводятся в стабильный API error без provider body.

## Runtime composition

```ts
const queuedOcr = createQueuedOcrProvider({
  provider: createGoogleVisionOcrProvider({ apiKey }),
  concurrency,
  maxPending,
  waitTimeoutMs,
});

const ocr = createCachedOcrProvider({
  provider: queuedOcr,
  store: database.ocrCache,
  ttlMs,
});
```

Cached provider остаётся внешним слоем: cache hits не занимают очередь. При
shutdown сервер дожидается OCR queue. Логи содержат только provider ID, outcome,
failure code и duration — без ключа, изображения и OCR-текста.

DeepSeek adapter создаётся только при `DEEPSEEK_ENABLED=true`; production требует
непустой ключ. Startup log содержит только model/prompt version.

## Команды

Проверки выполняются на server-side release candidate, не локально:

```bash
npm run typecheck
npm run lint
npm test
npm run build
docker build --tag whatthemake:<release> .
```

Production:

```bash
docker compose -p whatthemake \
  --env-file /srv/whatthemake/shared/.env \
  --env-file /srv/whatthemake/releases/<release>/.release.env \
  -f /srv/whatthemake/releases/<release>/deploy/production/compose.yml up -d
curl --fail https://whatthemake.ru/api/v1/ready
```

## Структура

- `packages/contracts` — OCR input и стабильный HTTP contract.
- `packages/domain` — OCR revision input без HTTP/provider imports.
- `packages/infrastructure` — Vision, queue, cache, PostgreSQL persistence.
- `apps/server` — config, ownership checks, route и composition.
- `apps/web` — явная кнопка OCR, progress/error и обновление workspace.
- `deploy/production` — env wiring и rollback-safe release.
- `apps/**/test`, `packages/**/test`, `tests` — contract/unit/integration/e2e.

## Code style

Используются discriminated unions и exhaustive handling:

```ts
const result = await ocr.recognize(request);
if (result.kind === 'FAILED') {
  throw ocrFailure(result.code, result.retryable);
}
return persistOriginal(result.text);
```

Provider payload не проходит внутрь домена без runtime validation. Ошибки имеют
стабильные codes; пользовательский текст и секреты не логируются.

## Тестирование

- contract: UUID body, additional properties rejected;
- service: чужой observation/asset и неверная role дают безопасный отказ;
- repository: OCR original создаётся один раз, duplicate reuse, manual conflict;
- provider composition: L1/L2/inflight/queue/abort/failure;
- UI: кнопка доступна только для `INGREDIENTS`, busy/error/success states;
- production smoke: readiness, DB, сайт, config metadata; реальные ключи и
  provider response не печатаются.

## Границы

### Всегда

- сохранять ownership/capability checks;
- оставлять OCR-текст проверяемым и исправляемым;
- сохранять deterministic INCI fallback;
- держать provider keys только в production env;
- сохранять предыдущий release для rollback.

### Сначала спросить

- автоматический OCR после upload;
- реальные DeepSeek-вызовы из пользовательского flow;
- новые платные provider calls в smoke;
- изменение DB schema или добавление dependency.

### Никогда

- не отправлять фото/текст DeepSeek;
- не считать LLM evidence или финальным решением;
- не логировать ключи, изображения, OCR/LLM body;
- не перезаписывать ручную редакцию OCR-результатом;
- не использовать food scoring/CLEAR Score.

## Критерии готовности

1. Production стартует только с валидной provider-конфигурацией.
2. Фото `INGREDIENTS` распознаётся через Google Vision по явному действию.
3. OCR revision immutable, traceable и доступна для ручной коррекции.
4. Повторный запрос использует inflight/L1/PostgreSQL L2 cache.
5. Provider failure оставляет ручной flow рабочим.
6. DeepSeek configured и constructed, но provider call count остаётся нулевым до
   появления утверждённого bounded consumer.
7. Тесты/build проходят на сервере; production readiness и rollback проверены.

## Открытый вопрос

Подтвердить ограничение: DeepSeek сейчас только runtime-ready, без
пользовательских вызовов. Его нельзя безопасно применить к сырому INCI; consumer
для claims/reviews будет отдельным срезом E4/F.
