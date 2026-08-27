# Implementation Plan: provider runtime

## Обзор

Вертикальный срез: production config → Google Vision queue/cache → защищённый
INCI OCR endpoint → immutable OCR revision → кнопка и коррекция в web.
DeepSeek создаётся в runtime, но не вызывается без отдельного bounded consumer.
Новая миграция и dependency не нужны.

## Граф зависимостей

```text
Config/env
  └─ Provider runtime
       ├─ Google Vision → queue → cache
       └─ DeepSeek metadata, calls disabled by absence of consumer

OCR revision domain/repository
  └─ Contract + service + route
       └─ Web action
            └─ Production smoke
```

## Архитектурные решения

- Cache оборачивает queue: L1/L2 hits не занимают provider concurrency.
- OCR запускается только явным `POST`.
- Ownership проверяется в service и повторно ограничивается repository query.
- Только asset role `INGREDIENTS` может стать источником INCI.
- OCR original имеет `authorKind: SYSTEM` и не заменяет ручной original.
- Request abort доходит до provider; shutdown дожидается queue.
- DeepSeek startup validation не выполняет платный network call.
- Один synthetic Google Vision smoke call после deploy проверяет реальный ключ,
  endpoint и egress без пользовательского фото.

## Задачи

### Task 1: Зафиксировать config contract

**Описание:** добавить строгие env-параметры Google Vision, OCR queue/cache и
DeepSeek; передать секреты в web container без значений в release env.

**Приёмка:**

- [ ] Production требует оба API key и `DEEPSEEK_ENABLED=true`.
- [ ] Числовые queue/cache параметры имеют bounds и безопасные defaults.
- [ ] Config errors не содержат значения секретов.

**Проверка:**

- [ ] `apps/server/test/config.test.ts` покрывает missing/invalid/valid config.
- [ ] Compose render проходит только с именами env; ключи не печатаются.

**Зависимости:** утверждённые spec/plan.

**Файлы:**

- `.env.example`
- `apps/server/src/config.ts`
- `apps/server/test/config.test.ts`
- `deploy/production/compose.yml`

**Размер:** M, 4 файла.

### Task 2: Добавить OCR original в domain/repository

**Описание:** расширить repository input системной OCR-редакцией и атомарно
сохранить provenance только для принадлежащего observation asset
`INGREDIENTS`.

**Приёмка:**

- [ ] Первая OCR-редакция создаётся как revision 1 и `SYSTEM`.
- [ ] Точный повтор переиспользуется; другой original возвращает conflict.
- [ ] Чужой asset, другая collection или role не сохраняются.

**Проверка:**

- [ ] PostgreSQL integration tests покрывают create/reuse/conflict/ownership.
- [ ] Existing manual correction tests остаются зелёными.

**Зависимости:** нет runtime-зависимости от Task 1.

**Файлы:**

- `packages/domain/src/inci-correction.ts`
- `packages/infrastructure/src/inci-correction-repository.ts`
- `packages/infrastructure/test/inci-correction.integration.test.ts`
- `package.json`

**Размер:** M, 4 файла.

### Checkpoint A

- [ ] Domain/infrastructure typecheck проходит.
- [ ] Repository не создаёт новую migration.
- [ ] Ни один secret/provider body не появился в diff.

### Task 3: Сделать защищённый OCR API slice

**Описание:** добавить request schema, service orchestration и route. Service
сверяет observation/asset, читает защищённый media object, вызывает OCR и
сохраняет original.

**Приёмка:**

- [ ] Endpoint принимает только `{ mediaAssetId }` и same-origin JSON.
- [ ] Auth/ownership/role проверяются до provider call.
- [ ] Provider failures дают стабильный retryable/non-retryable API error.
- [ ] Provider text и body никогда не логируются/возвращаются как diagnostic.

**Проверка:**

- [ ] Contract tests отвергают invalid UUID/additional properties.
- [ ] Server integration tests покрывают success, abort, wrong role, foreign
      asset, provider failure и duplicate.

**Зависимости:** Task 2.

**Файлы:**

- `packages/contracts/src/inci-correction.ts`
- `apps/server/src/inci-corrections/service.ts`
- `apps/server/src/routes/inci-corrections.ts`
- `apps/server/test/inci-ocr.integration.test.ts`
- `package.json`

**Размер:** M, 5 файлов.

### Task 4: Собрать providers в server runtime

**Описание:** создать Google Vision → queue → cache и DeepSeek adapters после DB
migration; передать OCR в service; сделать safe telemetry и graceful shutdown.

**Приёмка:**

- [ ] Cache hits обходят queue/provider.
- [ ] Server shutdown ждёт queue перед закрытием DB.
- [ ] Startup/telemetry содержат только IDs, versions, outcome, duration/code.
- [ ] DeepSeek constructed и configured; вызовов нет.

**Проверка:**

- [ ] Composition tests используют fake fetch/provider, без сети.
- [ ] Build/typecheck подтверждают DI и lifecycle.

**Зависимости:** Tasks 1 и 3.

**Файлы:**

- `apps/server/src/provider-runtime.ts`
- `apps/server/src/server.ts`
- `apps/server/test/provider-runtime.test.ts`
- `package.json`

**Размер:** M, 4 файла.

### Checkpoint B

- [ ] Contract/server/infrastructure tests проходят.
- [ ] Disabled/failure paths оставляют ручной INCI flow рабочим.
- [ ] Security review подтверждает отсутствие IDOR и secret logging.

### Task 5: Добавить явное OCR-действие в web

**Описание:** показать кнопку рядом с workspace только когда сохранено фото
`INGREDIENTS`; отобразить progress/error; после success обновить immutable
original, draft и analysis.

**Приёмка:**

- [ ] Без фото кнопки нет.
- [ ] Двойной клик не создаёт два запроса.
- [ ] Ошибка OCR не удаляет фото и оставляет ручной ввод.
- [ ] Success показывает provider provenance и распознанный текст для проверки.

**Проверка:**

- [ ] Playwright fixture покрывает success/error/duplicate/manual fallback.
- [ ] Mobile viewport не получает horizontal overflow.

**Зависимости:** Task 3.

**Файлы:**

- `apps/web/src/product-observation.tsx`
- `apps/web/src/inci-correction.tsx`
- `apps/web/src/styles.css`
- `tests/product-observation.spec.ts`

**Размер:** M, 4 файла.

### Task 6: Review и simplify

**Описание:** применить multi-axis review, security review и code simplification
к полному diff; исправить только подтверждённые проблемы.

**Приёмка:**

- [ ] Spec и implementation совпадают.
- [ ] Нет bypass ownership, raw provider leakage или лишней сложности.
- [ ] Все ошибки exhaustive; repeated orchestration вынесена только при реальной
      пользе.

**Проверка:**

- [ ] `git diff --check`.
- [ ] Secret scan по staged diff.
- [ ] Полный verification target Docker проходит на сервере.

**Зависимости:** Tasks 1–5.

**Файлы:** определяются findings; scope не расширяется.

**Размер:** S/M.

### Task 7: Immutable production rollout

**Описание:** commit/push, создать новый release directory/image на сервере,
пройти Docker verification target, переключить compose и проверить rollout.

**Приёмка:**

- [ ] Previous release/image сохранены и готовы для rollback.
- [ ] `/api/v1/ready`: `UP`, DB: `UP`, сайт: HTTP 200.
- [ ] Container получает обе provider env-переменные без вывода значений.
- [ ] Один synthetic Google Vision smoke call успешен.
- [ ] DeepSeek provider call count остаётся нулевым.

**Проверка:**

- [ ] Container health `healthy`.
- [ ] Build SHA равен deployed commit.
- [ ] Logs не содержат secrets/provider bodies.
- [ ] Rollback command рассчитан и проверен read-only.

**Зависимости:** Task 6.

**Файлы:** новых source-файлов нет; production release artifacts.

**Размер:** M, deployment.

## Риски

| Риск | Влияние | Митигация |
|---|---|---|
| IDOR между observation и asset | Высокое | Двойная ownership/collection/role проверка |
| Provider cost abuse | Среднее | Явное действие, rate limit, cache, queue |
| OCR перезапишет manual source | Высокое | Immutable original + conflict/reuse |
| Secret попадёт в log/compose output | Высокое | Safe telemetry; не выводить env/config |
| Provider outage сломает INCI | Среднее | Stable error + ручной deterministic flow |
| Deploy regression | Высокое | Verification target, previous release, health rollback |

## Последовательность и параллельность

Tasks 1 и 2 независимы, но выполняются последовательно в одном worktree. Tasks
3 → 4 → 5 зависят от общего contract. Review и deploy строго после полного slice.
Subagents не нужны.

## Решение, подтверждаемое вместе с планом

После deploy выполняется ровно один платный Google Vision smoke call на
синтетическом изображении без пользовательских данных. DeepSeek network smoke
не выполняется: реальный consumer ещё не утверждён.
