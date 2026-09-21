import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';

import { PrivateProductComparison } from './private-comparison.js';

import {
  CreatePrivateProductSnapshotResponseSchema,
  type CreatePrivateProductSnapshotInput,
  type PrivateProductSnapshot,
  type ProductClaimKind,
} from '@wtm/contracts';

const claimOptions: Array<{ value: ProductClaimKind; label: string }> = [
  { value: 'VOLUME', label: 'Объём' },
  { value: 'LENGTH', label: 'Удлинение' },
  { value: 'SEPARATION', label: 'Разделение' },
  { value: 'NATURAL_LOOK', label: 'Естественный эффект' },
  { value: 'EASY_REMOVAL', label: 'Лёгкое снятие' },
];

function userPrice(value: string): number | null {
  if (value.trim() === '') return null;
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value.trim())) {
    throw new Error(
      'Укажите цену в рублях: например, 599,90. Не больше двух знаков после запятой.',
    );
  }
  const [rubles = '', kopecks = ''] = value.trim().replace(',', '.').split('.');
  const amount = Number(rubles) * 100 + Number(kopecks.padEnd(2, '0'));
  if (amount < 1 || amount > 100_000_000)
    throw new Error('Цена должна быть от 0,01 до 1 000 000 рублей.');
  return amount;
}

function saveError(status: number): string {
  if (status === 401)
    return 'Приватная сессия недоступна. Откройте карточку заново; данные формы пока сохранены здесь.';
  if (status === 404)
    return 'Наблюдение или выбранная редакция недоступны. Откройте карточку заново.';
  if (status === 409)
    return 'Достигнут лимит сохранённых версий этой карточки.';
  if (status === 429)
    return 'Слишком много сохранений. Подождите и попробуйте снова.';
  return 'Не удалось сохранить карточку. Проверьте соединение и попробуйте снова.';
}

export function PrivateProductForm({
  observationId,
  revisionId,
  onSaved,
}: {
  observationId: string;
  revisionId: string;
  onSaved?(): void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PrivateProductSnapshot | null>(null);
  const pending = useRef<AbortController | null>(null);
  const savedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [observationId, revisionId],
  );
  useEffect(() => {
    if (saved) savedHeading.current?.focus();
  }, [saved]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    setError(null);
    let input: CreatePrivateProductSnapshotInput;
    try {
      const quantity = text('quantity').replace(',', '.');
      if (
        quantity &&
        (!/^\d{1,8}(?:\.\d{1,4})?$/.test(quantity) || Number(quantity) <= 0)
      ) {
        throw new Error(
          'Количество должно быть положительным числом: например, 8,5 мл.',
        );
      }
      if (!form.has('mascara') || !form.has('packaging'))
        throw new Error('Подтвердите категорию и сверку с упаковкой.');
      const waterproof = text('waterproof');
      input = {
        category: 'MASCARA',
        identityConfirmed: true,
        identity: {
          brandName: text('brand'),
          familyName: text('family'),
          variantName: text('variant'),
          shadeName: text('shade') || null,
          netQuantity: quantity
            ? {
                value: quantity,
                unit: text('unit') === 'GRAM' ? 'GRAM' : 'MILLILITER',
              }
            : null,
          isWaterproof: waterproof === 'UNKNOWN' ? null : waterproof === 'YES',
        },
        revisionId,
        formulaComplete: form.has('complete'),
        claimKinds: claimOptions
          .filter((option) => form.getAll('claims').includes(option.value))
          .map((option) => option.value),
        priceKopecks: userPrice(text('price')),
      };
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Проверьте поля карточки.',
      );
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/product-observations/${observationId}/private-snapshots`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(saveError(response.status));
      const payload: unknown = await response.json();
      if (
        !Value.Check(CreatePrivateProductSnapshotResponseSchema, payload) ||
        payload.snapshot.observationId !== observationId ||
        payload.snapshot.revision.revisionId !== revisionId
      ) {
        throw new Error(
          'Сервис вернул неподходящую карточку. Сохранение не подтверждено; попробуйте снова.',
        );
      }
      if (!controller.signal.aborted && pending.current === controller) {
        setSaved(payload.snapshot);
        onSaved?.();
      }
    } catch (cause) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось сохранить карточку. Попробуйте снова.',
        );
    } finally {
      if (!controller.signal.aborted && pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section
      className="private-product-workspace"
      aria-labelledby={`${id}-title`}
    >
      <h4 id={`${id}-title`}>Личная карточка по упаковке</h4>
      <p id={`${id}-hint`}>
        Перепишите сведения с этой упаковки. Они останутся вашим наблюдением, не
        проверенными данными производителя. Сохранится выбранная выше редакция
        INCI, а не несохранённый текст.
      </p>
      <form
        onSubmit={(event) => void save(event)}
        aria-describedby={`${id}-hint`}
        aria-busy={busy}
      >
        <fieldset className="comparison-preferences" disabled={busy}>
          <legend>Что указано на упаковке</legend>
          <label>
            Бренд
            <input name="brand" required maxLength={200} autoComplete="off" />
          </label>
          <label>
            Название продукта
            <input name="family" required maxLength={300} autoComplete="off" />
          </label>
          <label>
            Вариант продукта
            <input name="variant" required maxLength={300} autoComplete="off" />
          </label>
          <label>
            Оттенок — необязательно
            <input name="shade" maxLength={200} autoComplete="off" />
          </label>
          <label>
            Количество — необязательно
            <input
              name="quantity"
              inputMode="decimal"
              maxLength={13}
              autoComplete="off"
            />
          </label>
          <label>
            Единица количества
            <select name="unit" defaultValue="MILLILITER">
              <option value="MILLILITER">мл</option>
              <option value="GRAM">г</option>
            </select>
          </label>
          <label>
            Водостойкость по упаковке
            <select name="waterproof" defaultValue="UNKNOWN">
              <option value="UNKNOWN">Неизвестно / не указано</option>
              <option value="YES">Указана водостойкость</option>
              <option value="NO">Указано: неводостойкая</option>
            </select>
          </label>
          <label>
            Цена в магазине, ₽ — необязательно
            <input
              name="price"
              inputMode="decimal"
              maxLength={12}
              autoComplete="off"
            />
          </label>
          <fieldset>
            <legend>Только обещания, явно написанные на упаковке</legend>
            {claimOptions.map((option) => (
              <label key={option.value}>
                <input type="checkbox" name="claims" value={option.value} />
                {option.label}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Проверка перед сохранением</legend>
            <label>
              <input type="checkbox" name="mascara" required />
              Это тушь для ресниц, не праймер и не средство для бровей
            </label>
            <label>
              <input type="checkbox" name="packaging" required />Я сверил(а)
              название, вариант и отмеченные сведения с упаковкой
            </label>
            <label>
              <input type="checkbox" name="complete" />В выбранной редакции весь
              состав с упаковки, без пропусков
            </label>
            <small>
              Без подтверждения полноты нельзя делать вывод об отсутствии
              ингредиента. Даже полный текст может содержать ошибки
              распознавания.
            </small>
          </fieldset>
        </fieldset>
        <button type="submit" disabled={busy}>
          {busy ? 'Сохраняем карточку…' : 'Сохранить личную карточку'}
        </button>
        {busy && (
          <p role="status">
            Сохраняем неизменяемую версию с выбранным составом…
          </p>
        )}
        {error && (
          <p className="inci-correction-error" role="alert">
            {error}
          </p>
        )}
      </form>
      {saved && (
        <section className="inci-analysis" aria-labelledby={`${id}-saved`}>
          <h4 id={`${id}-saved`} tabIndex={-1} ref={savedHeading}>
            Личная карточка сохранена
          </h4>
          <p>
            {saved.identity.brandName} · {saved.identity.familyName} ·{' '}
            {saved.identity.variantName}
          </p>
          <p>
            GTIN {saved.barcode.value}. Версия карточки {saved.snapshotNumber};
            редакция состава {saved.revision.revisionNumber}. Источник сведений
            — ваша сверка с упаковкой.
          </p>
          <p>
            {saved.formulaComplete
              ? 'Полнота состава подтверждена вами. Это не независимая проверка.'
              : 'Полнота состава не подтверждена. Отсутствие ингредиентов не установлено.'}
          </p>
          <p>
            {saved.priceKopecks === null
              ? 'Цена не указана.'
              : `Введённая вами цена: ${new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(saved.priceKopecks / 100)}. Это не рыночная цена.`}
          </p>
          <details className="inci-source-evidence">
            <summary>Сохранённый текст и источник</summary>
            <pre>{saved.revision.sourceText}</pre>
            <p>Идентификатор карточки: {saved.snapshotId}</p>
            <p>SHA-256 текста:</p>
            <pre>{saved.revision.sourceSha256}</pre>
          </details>
          <small>
            Эта версия не изменится при следующем исправлении состава. Новое
            сохранение создаст отдельную версию. Карточка не публикуется в общем
            каталоге.
          </small>
        </section>
      )}
      {saved && (
        <PrivateProductComparison
          key={saved.snapshotId}
          initialSnapshot={saved}
        />
      )}
    </section>
  );
}
