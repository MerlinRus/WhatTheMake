import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';

import {
  ComparisonPreviewResponseSchema,
  type CatalogVariant,
  type ComparisonPreviewInput,
  type ComparisonPreviewResponse,
  type MascaraGoal,
} from '@wtm/contracts';

interface ProductComparisonProps {
  initialVariant: CatalogVariant;
  onClose(): void;
  onScan(requester: (gtin: string) => void): void;
}

const goalOptions: ReadonlyArray<{ value: MascaraGoal; label: string }> = [
  { value: 'VOLUME', label: 'Объём' },
  { value: 'LENGTH', label: 'Удлинение' },
  { value: 'SEPARATION', label: 'Разделение' },
  { value: 'NATURAL_LOOK', label: 'Естественный эффект' },
];

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

      <div className="comparison-slot-summary">
        {response.comparison.slots.map((slot) => (
          <article key={`${slot.slotIndex}-${slot.gtin}`}>
            <small>
              Вариант {slot.slotIndex + 1} · {slot.gtin}
            </small>
            <strong>{slotTitle(slot)}</strong>
            {slot.state === 'EXTERNAL_CANDIDATE' && (
              <span>Open Beauty Facts · данные не проверены</span>
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
  const [mode, setMode] = useState<'UNKNOWN_GOALS' | 'PERSONALIZED'>(
    'UNKNOWN_GOALS',
  );
  const [goals, setGoals] = useState<MascaraGoal[]>(['VOLUME']);
  const [waterproof, setWaterproof] = useState<
    'REQUIRED' | 'AVOID' | 'NO_PREFERENCE'
  >('NO_PREFERENCE');
  const [removal, setRemoval] = useState<'EASY_REQUIRED' | 'NO_PREFERENCE'>(
    'NO_PREFERENCE',
  );
  const [avoided, setAvoided] = useState('');
  const [sensitiveEyes, setSensitiveEyes] = useState(false);
  const [contactLenses, setContactLenses] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<
    | { kind: 'IDLE' }
    | { kind: 'LOADING' }
    | { kind: 'ERROR'; message: string }
    | { kind: 'DONE'; response: ComparisonPreviewResponse }
  >({ kind: 'IDLE' });

  const normalizedAvoided = useMemo(
    () =>
      avoided
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 50),
    [avoided],
  );

  useEffect(() => {
    workspaceRef.current?.focus();
  }, []);

  function updateGtin(value: string, setter: (next: string) => void) {
    setter(value.replace(/[^0-9]/g, '').slice(0, 14));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    if (normalizedAvoided.some((ingredient) => ingredient.length > 128)) {
      setStatus({
        kind: 'ERROR',
        message: 'Название исключаемого ингредиента — не длиннее 128 символов.',
      });
      return;
    }
    const shared = {
      waterproof,
      removal,
      sensitiveEyes,
      contactLenses,
      avoidedIngredients: normalizedAvoided,
    };
    const input: ComparisonPreviewInput = {
      schemaVersion: 1,
      gtins,
      brief:
        mode === 'PERSONALIZED'
          ? { mode, goals, ...shared }
          : { mode, ...shared },
    };
    setStatus({ kind: 'LOADING' });
    try {
      const response = await fetch('/api/v1/comparisons/preview', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new Error(`Comparison returned ${response.status}`);
      const payload: unknown = await response.json();
      if (!Value.Check(ComparisonPreviewResponseSchema, payload)) {
        throw new Error('Comparison returned an invalid response');
      }
      setStatus({ kind: 'DONE', response: payload });
    } catch {
      setStatus({
        kind: 'ERROR',
        message: 'Сравнение временно недоступно. Попробуйте ещё раз.',
      });
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

      <form onSubmit={submit}>
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
              <button type="button" onClick={() => onScan(setSecondGtin)}>
                Сканировать
              </button>
            </div>
          </label>
          {thirdGtin === null ? (
            <button
              type="button"
              className="add-third"
              onClick={() => setThirdGtin('')}
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
                <button type="button" onClick={() => onScan(setThirdGtin)}>
                  Сканировать
                </button>
              </div>
              <button
                type="button"
                className="remove-third"
                onClick={() => setThirdGtin(null)}
              >
                Убрать третий вариант
              </button>
            </label>
          )}
        </div>

        <fieldset className="comparison-mode">
          <legend>Как выбирать</legend>
          <label>
            <input
              type="radio"
              name="comparison-mode"
              checked={mode === 'UNKNOWN_GOALS'}
              onChange={() => setMode('UNKNOWN_GOALS')}
            />
            Не знаю — помогите выбрать
          </label>
          <label>
            <input
              type="radio"
              name="comparison-mode"
              checked={mode === 'PERSONALIZED'}
              onChange={() => setMode('PERSONALIZED')}
            />
            У меня есть пожелания
          </label>
        </fieldset>

        {mode === 'PERSONALIZED' && (
          <div className="comparison-preferences">
            <fieldset>
              <legend>Желаемый эффект</legend>
              {goalOptions.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={goals.includes(option.value)}
                    onChange={(event) =>
                      setGoals((current) =>
                        event.target.checked
                          ? [...new Set([...current, option.value])]
                          : current.filter((goal) => goal !== option.value),
                      )
                    }
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <label>
              Водостойкость
              <select
                value={waterproof}
                onChange={(event) =>
                  setWaterproof(event.target.value as typeof waterproof)
                }
              >
                <option value="NO_PREFERENCE">Неважно</option>
                <option value="REQUIRED">Нужна</option>
                <option value="AVOID">Не нужна</option>
              </select>
            </label>
            <label>
              Снятие
              <select
                value={removal}
                onChange={(event) =>
                  setRemoval(event.target.value as typeof removal)
                }
              >
                <option value="NO_PREFERENCE">Неважно</option>
                <option value="EASY_REQUIRED">Нужно лёгкое</option>
              </select>
            </label>
            <fieldset>
              <legend>Дополнительный контекст</legend>
              <label>
                <input
                  type="checkbox"
                  checked={sensitiveEyes}
                  onChange={(event) => setSensitiveEyes(event.target.checked)}
                />
                Чувствительные глаза
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={contactLenses}
                  onChange={(event) => setContactLenses(event.target.checked)}
                />
                Контактные линзы
              </label>
              <small>
                Покажем нехватку данных, но не будем делать медицинский вывод.
              </small>
            </fieldset>
            <label>
              Исключить ингредиенты — через запятую
              <input
                value={avoided}
                maxLength={1000}
                onChange={(event) => setAvoided(event.target.value)}
              />
            </label>
          </div>
        )}

        <button
          type="submit"
          className="compare-submit"
          disabled={
            status.kind === 'LOADING' ||
            (mode === 'PERSONALIZED' && goals.length === 0)
          }
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
