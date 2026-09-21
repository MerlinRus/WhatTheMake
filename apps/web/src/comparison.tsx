import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';

import {
  ComparisonPreviewResponseSchema,
  type CatalogVariant,
  type ComparisonPreviewInput,
  type ComparisonPreviewResponse,
} from '@wtm/contracts';

import { MascaraBriefEditor, useMascaraBrief } from './mascara-brief-editor.js';

interface ProductComparisonProps {
  initialVariant: CatalogVariant;
  onClose(): void;
  onScan(requester: (gtin: string) => void): void;
}

const criterionLabels: Record<
  ComparisonPreviewResponse['comparison']['criteria'][number]['kind'],
  string
> = {
  IDENTITY_AND_DATA: 'Точность вариантов',
  HARD_CONSTRAINTS: 'Обязательные условия',
  DESIRED_EFFECT: 'Желаемый эффект',
  CUSTOMER_REVIEWS: 'Отзывы покупателей',
  FORMULA_AND_CLAIMS: 'Состав и claims',
  PRICE_AND_VALUE: 'Цена и ценность',
};

const outcomeLabels = {
  ADVANTAGE: 'Преимущество',
  DISADVANTAGE: 'Не подходит',
  NEUTRAL: 'Без различия',
  NO_DATA: 'Нет данных',
} as const;

function slotTitle(
  slot: ComparisonPreviewResponse['comparison']['slots'][number],
): string {
  if (slot.state === 'READY') {
    return `${slot.variant.brandName} · ${slot.variant.familyName}`;
  }
  if (slot.state === 'EXTERNAL_CANDIDATE') {
    return `${slot.candidate.brandName ?? 'Бренд не указан'} · ${slot.candidate.productName}`;
  }
  if (slot.state === 'DUPLICATE_VARIANT') return 'Повтор того же варианта';
  if (slot.state === 'INVALID_GTIN') return 'Некорректный GTIN';
  if (slot.state === 'SOURCE_UNAVAILABLE')
    return 'Источник временно недоступен — повторите поиск';
  if (slot.state === 'UNSUPPORTED_CATEGORY')
    return 'Этот товар не относится к поддерживаемой категории';
  return 'Товар не найден';
}

function ComparisonResult({
  response,
}: {
  response: ComparisonPreviewResponse;
}) {
  const recommendation = response.comparison.recommendation;
  const preferred =
    recommendation.kind === 'PREFERRED'
      ? response.comparison.slots.find(
          (slot) =>
            slot.state === 'READY' &&
            slot.variant.productVariantId === recommendation.productVariantId,
        )
      : null;

  return (
    <section
      className="comparison-result"
      aria-labelledby="comparison-result-title"
    >
      <header>
        <span className="eyebrow">Осторожная рекомендация</span>
        <h2 id="comparison-result-title">
          {preferred?.state === 'READY'
            ? `Лучше подходит: ${preferred.variant.brandName} ${preferred.variant.familyName}`
            : 'Явного победителя нет'}
        </h2>
        <p>
          {preferred?.state === 'READY'
            ? 'Выбор основан только на доступных подтверждённых критериях.'
            : 'Данных недостаточно или различия слишком близки. Это нормальный результат.'}
        </p>
      </header>

      {response.comparison.warnings?.map((warning) => (
        <p key={warning} className="comparison-error" role="note">
          {warning}
        </p>
      ))}

      <div className="comparison-slot-summary">
        {response.comparison.slots.map((slot) => (
          <article key={`${slot.slotIndex}-${slot.gtin}`}>
            <small>
              Вариант {slot.slotIndex + 1} · {slot.gtin}
            </small>
            <strong>{slotTitle(slot)}</strong>
            {slot.state === 'EXTERNAL_CANDIDATE' && (
              <span>{slot.candidate.providerLabel} · данные не проверены</span>
            )}
          </article>
        ))}
      </div>

      <div className="criteria-list">
        {response.comparison.criteria.map((criterion) => (
          <section key={criterion.kind}>
            <h3>{criterionLabels[criterion.kind]}</h3>
            <div>
              {criterion.observations.map((item) => (
                <article key={item.slotIndex} data-outcome={item.outcome}>
                  <small>Вариант {item.slotIndex + 1}</small>
                  <strong>{outcomeLabels[item.outcome]}</strong>
                  <p>{item.explanation}</p>
                  {item.evidence.map((evidence) => (
                    <span key={evidence}>{evidence}</span>
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

export function ProductComparison({
  initialVariant,
  onClose,
  onScan,
}: ProductComparisonProps) {
  const [secondGtin, setSecondGtin] = useState('');
  const [thirdGtin, setThirdGtin] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<
    | { kind: 'IDLE' }
    | { kind: 'LOADING' }
    | { kind: 'ERROR'; message: string }
    | { kind: 'DONE'; response: ComparisonPreviewResponse }
  >({ kind: 'IDLE' });

  const preferences = useMascaraBrief(invalidate);

  function invalidate() {
    pending.current?.abort();
    pending.current = null;
    setStatus({ kind: 'IDLE' });
  }

  useEffect(() => {
    workspaceRef.current?.focus();
    return () => pending.current?.abort();
  }, []);

  function updateGtin(value: string, setter: (next: string) => void) {
    invalidate();
    setter(value.replace(/[^0-9]/g, '').slice(0, 14));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !preferences.ready) return;
    const gtins = [
      initialVariant.barcode.value,
      secondGtin,
      ...(thirdGtin === null || thirdGtin === '' ? [] : [thirdGtin]),
    ];
    if (new Set(gtins).size !== gtins.length) {
      setStatus({
        kind: 'ERROR',
        message: 'Каждый слот должен содержать другой GTIN.',
      });
      return;
    }
    if (
      ![secondGtin, thirdGtin]
        .filter((value) => value !== null)
        .every(
          (value) => value === '' || [8, 12, 13, 14].includes(value.length),
        )
    ) {
      setStatus({ kind: 'ERROR', message: 'Проверьте длину GTIN в слотах.' });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setStatus({ kind: 'LOADING' });
    try {
      const brief = await preferences.prepareComparison(controller.signal);
      if (!brief) {
        if (!controller.signal.aborted) setStatus({ kind: 'IDLE' });
        return;
      }
      const input: ComparisonPreviewInput = { schemaVersion: 1, gtins, brief };
      const response = await fetch('/api/v1/comparisons/preview', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error(`Comparison returned ${response.status}`);
      const payload: unknown = await response.json();
      if (!Value.Check(ComparisonPreviewResponseSchema, payload)) {
        throw new Error('Comparison returned an invalid response');
      }
      if (!controller.signal.aborted && pending.current === controller)
        setStatus({ kind: 'DONE', response: payload });
    } catch {
      if (!controller.signal.aborted && pending.current === controller)
        setStatus({
          kind: 'ERROR',
          message: 'Сравнение временно недоступно. Попробуйте ещё раз.',
        });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  return (
    <section
      ref={workspaceRef}
      className="comparison-workspace"
      aria-labelledby="comparison-title"
      tabIndex={-1}
    >
      <header>
        <div>
          <span className="eyebrow">Сравнение у полки</span>
          <h2 id="comparison-title">Что взять?</h2>
          <p>
            Добавьте ещё одну или две туши. Первый точный вариант уже
            зафиксирован.
          </p>
        </div>
        <button type="button" className="comparison-close" onClick={onClose}>
          Закрыть
        </button>
      </header>

      <form onSubmit={submit} onChange={invalidate}>
        <div className="comparison-slots">
          <label>
            <span>Вариант 1 · подтверждён</span>
            <strong>
              {initialVariant.brandName} · {initialVariant.familyName}
            </strong>
            <small>{initialVariant.barcode.value}</small>
          </label>
          <label>
            <span>Вариант 2</span>
            <div>
              <input
                aria-label="GTIN варианта 2"
                inputMode="numeric"
                value={secondGtin}
                required
                maxLength={14}
                onChange={(event) =>
                  updateGtin(event.target.value, setSecondGtin)
                }
              />
              <button
                type="button"
                onClick={() =>
                  onScan((value) => updateGtin(value, setSecondGtin))
                }
              >
                Сканировать
              </button>
            </div>
          </label>
          {thirdGtin === null ? (
            <button
              type="button"
              className="add-third"
              onClick={() => {
                invalidate();
                setThirdGtin('');
              }}
            >
              + Добавить третий вариант
            </button>
          ) : (
            <label>
              <span>Вариант 3</span>
              <div>
                <input
                  aria-label="GTIN варианта 3"
                  inputMode="numeric"
                  value={thirdGtin}
                  required
                  maxLength={14}
                  onChange={(event) =>
                    updateGtin(event.target.value, setThirdGtin)
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    onScan((value) => updateGtin(value, setThirdGtin))
                  }
                >
                  Сканировать
                </button>
              </div>
              <button
                type="button"
                className="remove-third"
                onClick={() => {
                  invalidate();
                  setThirdGtin(null);
                }}
              >
                Убрать третий вариант
              </button>
            </label>
          )}
        </div>

        <MascaraBriefEditor brief={preferences} />

        <button
          type="submit"
          className="compare-submit"
          disabled={status.kind === 'LOADING' || !preferences.ready}
        >
          {status.kind === 'LOADING' ? 'Сравниваем…' : 'Сравнить варианты'}
        </button>
        {status.kind === 'ERROR' && (
          <p className="comparison-error" role="alert">
            {status.message}
          </p>
        )}
      </form>

      {status.kind === 'DONE' && (
        <ComparisonResult response={status.response} />
      )}
    </section>
  );
}
