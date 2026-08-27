import { useEffect, useState, type ChangeEvent } from 'react';
import { Value } from 'typebox/value';

import {
  MediaAssetResponseSchema,
  ProductObservationResponseSchema,
  SessionResponseSchema,
  type MediaRole,
  type ProductObservation,
} from '@wtm/contracts';

import { InciCorrectionWorkspace } from './inci-correction.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const roles: Array<{
  role: MediaRole;
  label: string;
  hint: string;
  optional?: boolean;
}> = [
  { role: 'FRONT', label: 'Название', hint: 'Лицевая сторона упаковки' },
  {
    role: 'INGREDIENTS',
    label: 'Состав INCI',
    hint: 'Текст целиком и в фокусе',
  },
  { role: 'CLAIMS', label: 'Обещания', hint: 'Эффект, водостойкость, снятие' },
  { role: 'BARCODE', label: 'Штрихкод', hint: 'Код и цифры под ним' },
  {
    role: 'PRICE_TAG',
    label: 'Ценник',
    hint: 'Если хотите учесть цену',
    optional: true,
  },
];

type CaptureState =
  | { kind: 'LOADING' }
  | { kind: 'ERROR'; message: string }
  | { kind: 'READY'; observation: ProductObservation };

function captureError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось сохранить наблюдение. Попробуйте ещё раз.';
}

async function createObservation(
  gtin: string,
  signal: AbortSignal,
): Promise<ProductObservation> {
  const sessionResponse = await fetch('/api/v1/guest-sessions', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!sessionResponse.ok)
    throw new Error('Не удалось открыть приватную сессию.');
  const session: unknown = await sessionResponse.json();
  if (!Value.Check(SessionResponseSchema, session)) {
    throw new Error('Сервис сессий вернул некорректный ответ.');
  }

  const response = await fetch('/api/v1/product-observations', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ gtin }),
    signal,
  });
  if (!response.ok) throw new Error('Не удалось создать приватное наблюдение.');
  const payload: unknown = await response.json();
  if (!Value.Check(ProductObservationResponseSchema, payload)) {
    throw new Error('Сервис наблюдений вернул некорректный ответ.');
  }
  return payload.observation;
}

export function ProductObservationCapture({ gtin }: { gtin: string }) {
  const [state, setState] = useState<CaptureState>({ kind: 'LOADING' });
  const [busyRole, setBusyRole] = useState<MediaRole | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'LOADING' });
    void createObservation(gtin, controller.signal)
      .then((observation) => setState({ kind: 'READY', observation }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'ERROR', message: captureError(error) });
        }
      });
    return () => controller.abort();
  }, [gtin]);

  async function upload(role: MediaRole, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || state.kind !== 'READY') return;
    if (!imageTypes.has(file.type)) {
      setActionError('Нужен JPEG, PNG или WebP.');
      return;
    }
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setActionError('Размер фото должен быть от 1 байта до 8 МБ.');
      return;
    }

    setBusyRole(role);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/v1/media-collections/${state.observation.mediaCollection.collectionId}/assets?role=${role}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': file.type },
          body: file,
        },
      );
      if (!response.ok)
        throw new Error('Фото не сохранилось. Попробуйте ещё раз.');
      const payload: unknown = await response.json();
      if (!Value.Check(MediaAssetResponseSchema, payload)) {
        throw new Error('Сервис фото вернул некорректный ответ.');
      }
      setState((current) =>
        current.kind !== 'READY'
          ? current
          : {
              kind: 'READY',
              observation: {
                ...current.observation,
                mediaCollection: {
                  ...current.observation.mediaCollection,
                  assets: [
                    ...current.observation.mediaCollection.assets.filter(
                      (asset) => asset.role !== role,
                    ),
                    payload.asset,
                  ],
                },
              },
            },
      );
    } catch (error) {
      setActionError(captureError(error));
    } finally {
      setBusyRole(null);
    }
  }

  async function remove(assetId: string, role: MediaRole) {
    setBusyRole(role);
    setActionError(null);
    try {
      const response = await fetch(`/api/v1/media-assets/${assetId}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Не удалось удалить фото.');
      setState((current) =>
        current.kind !== 'READY'
          ? current
          : {
              kind: 'READY',
              observation: {
                ...current.observation,
                mediaCollection: {
                  ...current.observation.mediaCollection,
                  assets: current.observation.mediaCollection.assets.filter(
                    (asset) => asset.assetId !== assetId,
                  ),
                },
              },
            },
      );
    } catch (error) {
      setActionError(captureError(error));
    } finally {
      setBusyRole(null);
    }
  }

  if (state.kind === 'LOADING') {
    return (
      <div className="status-panel loading" role="status">
        <span aria-hidden="true" /> Создаём приватную карточку…
      </div>
    );
  }
  if (state.kind === 'ERROR') {
    return (
      <div className="status-panel capture-error" role="alert">
        <h2>Карточка не создалась</h2>
        <p>{state.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Попробовать снова
        </button>
      </div>
    );
  }

  const assets = state.observation.mediaCollection.assets;
  return (
    <article className="observation-card" aria-labelledby="observation-title">
      <header>
        <span className="eyebrow">Личное наблюдение</span>
        <h2 id="observation-title">Сфотографируйте упаковку</h2>
        <p>
          GTIN {state.observation.barcode.value}. Фото видны только вам и не
          публикуются в общем каталоге.
        </p>
      </header>

      <div className="capture-progress" role="status">
        <strong>{assets.length} из 5</strong>
        <span>Каждое фото сохраняется сразу</span>
      </div>

      <div className="capture-grid">
        {roles.map((item) => {
          const asset = assets.find(
            (candidate) => candidate.role === item.role,
          );
          const isBusy = busyRole === item.role;
          return (
            <section className="capture-role" key={item.role}>
              <div>
                <strong>{item.label}</strong>
                {item.optional && <span>необязательно</span>}
                <small>{item.hint}</small>
              </div>
              {asset ? (
                <div className="capture-preview">
                  <img
                    src={`/api/v1/media-assets/${asset.assetId}`}
                    alt={`Сохранённое фото: ${item.label}`}
                  />
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void remove(asset.assetId, item.role)}
                  >
                    {isBusy ? 'Удаляем…' : 'Удалить'}
                  </button>
                </div>
              ) : (
                <label className={isBusy ? 'is-busy' : undefined}>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    disabled={isBusy || busyRole !== null}
                    onChange={(event) => void upload(item.role, event)}
                  />
                  {isBusy ? 'Сохраняем…' : 'Сделать фото'}
                </label>
              )}
            </section>
          );
        })}
      </div>

      <InciCorrectionWorkspace
        observationId={state.observation.observationId}
      />

      {actionError && (
        <p className="capture-action-error" role="alert">
          {actionError}
        </p>
      )}
      <footer>
        <strong>
          {assets.length >= 4
            ? 'Основные фото сохранены'
            : 'Можно продолжить позже'}
        </strong>
        <span>Повторный поиск этого штрихкода откроет ту же карточку.</span>
      </footer>
    </article>
  );
}
