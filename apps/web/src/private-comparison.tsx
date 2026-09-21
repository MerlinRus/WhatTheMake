import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';

import {
  PrivateComparisonInputSchema,
  PrivateComparisonResponseSchema,
  PrivateProductListResponseSchema,
  type PrivateComparisonInput,
  type PrivateComparisonResponse,
  type PrivateComparisonSlot,
  type PrivateProductSnapshot,
} from '@wtm/contracts';

import { MascaraBriefEditor, useMascaraBrief } from './mascara-brief-editor.js';
const criteriaLabels = {
  IDENTITY_AND_DATA: 'Точность вариантов',
  HARD_CONSTRAINTS: 'Обязательные условия',
  DESIRED_EFFECT: 'Желаемый эффект',
  CUSTOMER_REVIEWS: 'Отзывы покупателей',
  FORMULA_AND_CLAIMS: 'Состав и обещания',
  PRICE_AND_VALUE: 'Цена и ценность',
};
const outcomes = {
  ADVANTAGE: 'Преимущество',
  DISADVANTAGE: 'Не подходит',
  NEUTRAL: 'Без различия',
  NO_DATA: 'Нет данных',
};
const unavailableLabels = {
  NOT_FOUND: 'Товар или личная карточка недоступны',
  INVALID_GTIN: 'Некорректный GTIN',
  SOURCE_UNAVAILABLE: 'Источник временно недоступен',
  UNSUPPORTED_CATEGORY: 'Не относится к поддерживаемой категории',
  DUPLICATE_VARIANT: 'Повтор того же варианта',
};

function identityLabel(snapshot: PrivateProductSnapshot): string {
  return `${snapshot.identity.brandName} · ${snapshot.identity.familyName} · ${snapshot.identity.variantName}`;
}
function slotLabel(slot: PrivateComparisonSlot): string {
  if (slot.state === 'PRIVATE_READY') return identityLabel(slot.snapshot);
  if (slot.state === 'CATALOG_READY')
    return `${slot.variant.brandName} · ${slot.variant.familyName} · ${slot.variant.variantName}`;
  return unavailableLabels[slot.reason];
}

function SnapshotEvidence({ snapshot }: { snapshot: PrivateProductSnapshot }) {
  return (
    <>
      <p>
        Личная карточка · GTIN {snapshot.barcode.value} · версия{' '}
        {snapshot.snapshotNumber}. Название и обещания сверены вами с упаковкой,
        не проверены производителем.
      </p>
      <p>
        Редакция INCI {snapshot.revision.revisionNumber}:{' '}
        {snapshot.formulaComplete
          ? 'полнота подтверждена вами'
          : 'полнота не подтверждена — отсутствие ингредиентов не установлено'}
        .
      </p>
      <p>
        {snapshot.priceKopecks === null
          ? 'Ваша цена не указана.'
          : `Ваша цена: ${new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(snapshot.priceKopecks / 100)}. Не рыночная оценка.`}
      </p>
    </>
  );
}

function Result({
  response,
  titleId,
}: {
  response: PrivateComparisonResponse;
  titleId: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [response]);
  const result = response.comparison;
  const recommendation = result.recommendation;
  const preferred =
    recommendation.kind === 'PREFERRED'
      ? result.slots.find(
          (slot) =>
            slot.slotIndex === recommendation.slotIndex &&
            slot.state !== 'UNAVAILABLE',
        )
      : undefined;
  return (
    <section className="comparison-result" aria-labelledby={titleId}>
      <h3 id={titleId} tabIndex={-1} ref={heading}>
        {preferred
          ? `Лучше подходит: ${slotLabel(preferred)}`
          : 'Явного победителя нет'}
      </h3>
      <p>
        {preferred
          ? 'Выбор по указанным условиям и доступным сведениям. Данные вашей упаковки остаются пользовательским подтверждением.'
          : 'Недостаточно данных или убедительных различий. Это не оценка безопасности или качества.'}
      </p>
      {result.warnings.map((warning, index) => (
        <p className="comparison-error" role="note" key={index}>
          {warning}
        </p>
      ))}
      <div className="comparison-slot-summary">
        {result.slots.map((slot) => (
          <article key={slot.slotIndex}>
            <small>Вариант {slot.slotIndex + 1}</small>
            <strong>{slotLabel(slot)}</strong>
            {slot.state === 'PRIVATE_READY' && (
              <SnapshotEvidence snapshot={slot.snapshot} />
            )}
            {slot.state === 'CATALOG_READY' && (
              <>
                <p>
                  Каталог · GTIN {slot.gtin}. Источник идентификации:{' '}
                  {slot.variant.identitySources.barcode.sourceLabel}.
                </p>
                {slot.variant.identitySources.barcode.sourceUrl && (
                  <a
                    href={slot.variant.identitySources.barcode.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Источник карточки
                  </a>
                )}
                <p>
                  {slot.variant.formula
                    ? 'Состав есть в каталоге; сверяйте с вашей упаковкой.'
                    : 'Состава в каталоге нет.'}
                </p>
                <p>
                  {slot.review
                    ? `Рейтинг покупателей: ${slot.review.ratingValue} из 5; отзывов: ${slot.review.reviewCount}. Данные на ${new Date(slot.review.asOf).toLocaleDateString('ru-RU')}.`
                    : 'Отзывы покупателей недоступны.'}
                </p>
              </>
            )}
          </article>
        ))}
      </div>
      <div className="criteria-list">
        {result.criteria.map((criterion) => (
          <section key={criterion.kind}>
            <h4>{criteriaLabels[criterion.kind]}</h4>
            <div>
              {criterion.observations.map((item) => (
                <article key={item.slotIndex} data-outcome={item.outcome}>
                  <small>Вариант {item.slotIndex + 1}</small>
                  <strong>{outcomes[item.outcome]}</strong>
                  <p>{item.explanation}</p>
                  {item.evidence.map((evidence, index) => (
                    <span key={index}>{evidence}</span>
                  ))}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

type Status =
  | { kind: 'IDLE' | 'LOADING' }
  | { kind: 'ERROR'; message: string }
  | { kind: 'DONE'; response: PrivateComparisonResponse };

export function PrivateProductComparison({
  initialSnapshot,
  onClose,
}: {
  initialSnapshot: PrivateProductSnapshot;
  onClose?: () => void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<PrivateProductSnapshot[]>([]);
  const [listState, setListState] = useState<'LOADING' | 'READY' | 'ERROR'>(
    'LOADING',
  );
  const [refresh, setRefresh] = useState(0);
  const [secondKind, setSecondKind] = useState<'PRIVATE' | 'CATALOG'>(
    'PRIVATE',
  );
  const [status, setStatus] = useState<Status>({ kind: 'IDLE' });
  const pending = useRef<AbortController | null>(null);
  const preferences = useMascaraBrief(invalidate);

  useEffect(() => {
    const controller = new AbortController();
    setListState('LOADING');
    void fetch('/api/v1/private-products?limit=30', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Private list unavailable');
        const payload: unknown = await response.json();
        if (!Value.Check(PrivateProductListResponseSchema, payload))
          throw new Error('Private list invalid');
        if (!controller.signal.aborted) {
          setChoices(
            payload.snapshots.filter(
              (snapshot) =>
                snapshot.observationId !== initialSnapshot.observationId,
            ),
          );
          setListState('READY');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setListState('ERROR');
      });
    return () => controller.abort();
  }, [initialSnapshot.observationId, refresh]);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [initialSnapshot.snapshotId],
  );

  function invalidate() {
    pending.current?.abort();
    pending.current = null;
    setStatus({ kind: 'IDLE' });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !preferences.ready) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const controller = new AbortController();
    pending.current = controller;
    setStatus({ kind: 'LOADING' });
    try {
      const brief = await preferences.prepareComparison(controller.signal);
      if (!brief) {
        if (!controller.signal.aborted) setStatus({ kind: 'IDLE' });
        return;
      }
      const input: PrivateComparisonInput = {
        schemaVersion: 1,
        slots: [
          { kind: 'PRIVATE', snapshotId: initialSnapshot.snapshotId },
          secondKind === 'PRIVATE'
            ? { kind: 'PRIVATE', snapshotId: text('snapshot') }
            : { kind: 'CATALOG', gtin: text('gtin') },
        ],
        brief,
      };
      if (!Value.Check(PrivateComparisonInputSchema, input)) {
        setStatus({
          kind: 'ERROR',
          message:
            'Выберите другую карточку или введите GTIN из 8, 12, 13 или 14 цифр.',
        });
        return;
      }
      const response = await fetch('/api/v1/comparisons/private-preview', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? 'Приватная сессия недоступна. Откройте карточку заново.'
            : response.status === 429
              ? 'Слишком много сравнений. Подождите и попробуйте снова.'
              : 'Сравнение временно недоступно. Попробуйте ещё раз.',
        );
      const payload: unknown = await response.json();
      if (!Value.Check(PrivateComparisonResponseSchema, payload))
        throw new Error(
          'Сервис вернул некорректное сравнение. Попробуйте снова.',
        );
      if (!controller.signal.aborted && pending.current === controller)
        setStatus({ kind: 'DONE', response: payload });
    } catch (cause) {
      if (!controller.signal.aborted && pending.current === controller)
        setStatus({
          kind: 'ERROR',
          message:
            cause instanceof TypeError
              ? 'Нет соединения. Проверьте сеть и повторите сравнение.'
              : cause instanceof Error
                ? cause.message
                : 'Не удалось выполнить сравнение.',
        });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  return (
    <section
      className="private-comparison comparison-workspace"
      aria-labelledby={`${id}-title`}
    >
      <header>
        <div>
          <span className="eyebrow">Сравнение по вашим данным</span>
          <h3 id={`${id}-title`}>С чем сравнить личную карточку?</h3>
          <p>
            Можно выбрать другую сохранённую тушь или товар из каталога.
            Источники не смешиваются: пользовательские сведения не становятся
            проверенными фактами производителя.
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose}>
            Закрыть сравнение
          </button>
        )}
      </header>
      <strong>Вариант 1 · {identityLabel(initialSnapshot)}</strong>
      <SnapshotEvidence snapshot={initialSnapshot} />
      <form
        onSubmit={(event) => void submit(event)}
        onChange={invalidate}
        aria-busy={status.kind === 'LOADING'}
      >
        <fieldset className="comparison-mode">
          <legend>Откуда взять вариант 2</legend>
          <label>
            <input
              type="radio"
              name={`${id}-source`}
              checked={secondKind === 'PRIVATE'}
              onChange={() => setSecondKind('PRIVATE')}
            />
            Моя сохранённая карточка
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-source`}
              checked={secondKind === 'CATALOG'}
              onChange={() => setSecondKind('CATALOG')}
            />
            GTIN из каталога
          </label>
        </fieldset>
        {secondKind === 'PRIVATE' ? (
          <>
            {listState === 'LOADING' && (
              <p role="status">Загружаем личные карточки…</p>
            )}
            {listState === 'ERROR' && (
              <div>
                <p role="alert">
                  Не удалось загрузить ваши карточки. Можно повторить или ввести
                  GTIN.
                </p>
                <button
                  type="button"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  Повторить загрузку карточек
                </button>
              </div>
            )}
            {listState === 'READY' && choices.length === 0 && (
              <p>
                Других сохранённых товаров пока нет. Добавьте ещё одну упаковку
                или используйте GTIN из каталога.
              </p>
            )}
            <label>
              Вторая личная карточка
              <select
                name="snapshot"
                required
                disabled={listState !== 'READY' || choices.length === 0}
                defaultValue=""
              >
                <option value="" disabled>
                  Выберите сохранённый товар
                </option>
                {choices.map((snapshot) => (
                  <option key={snapshot.snapshotId} value={snapshot.snapshotId}>
                    {identityLabel(snapshot)} · версия {snapshot.snapshotNumber}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label>
            GTIN второго товара
            <input
              name="gtin"
              inputMode="numeric"
              required
              maxLength={14}
              pattern="[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14}"
              autoComplete="off"
            />
          </label>
        )}
        <MascaraBriefEditor brief={preferences} />

        <button
          type="submit"
          disabled={
            status.kind === 'LOADING' ||
            !preferences.ready ||
            (secondKind === 'PRIVATE' &&
              (listState !== 'READY' || choices.length === 0))
          }
        >
          {status.kind === 'LOADING'
            ? 'Сравниваем карточки…'
            : 'Сравнить с личной карточкой'}
        </button>
        {status.kind === 'LOADING' && (
          <p role="status">Сравниваем доступные сведения…</p>
        )}
        {status.kind === 'ERROR' && (
          <p className="comparison-error" role="alert">
            {status.message}
          </p>
        )}
      </form>
      {status.kind === 'DONE' && (
        <Result response={status.response} titleId={`${id}-result`} />
      )}
    </section>
  );
}
