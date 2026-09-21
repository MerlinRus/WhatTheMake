import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';
import {
  CustomerReviewDeleteResponseSchema,
  CustomerReviewOwnResponseSchema,
  CustomerReviewSummaryResponseSchema,
  CustomerReviewWriteResponseSchema,
  SessionResponseSchema,
  type CustomerReview,
  type CustomerReviewSummaryResponse,
} from '@wtm/contracts';
import { CustomerReviewMentions } from './customer-review-mentions';

export interface CustomerReviewsProps {
  productVariantId: string;
  sessionEpoch?: number;
}
type SummaryState =
  | { kind: 'LOADING' }
  | { kind: 'ERROR' }
  | { kind: 'READY'; summary: CustomerReviewSummaryResponse['summary'] };
type OwnState =
  | { kind: 'LOADING' | 'GUEST' | 'ERROR' }
  | { kind: 'ACCOUNT'; accountId: string };

async function request(
  path: string,
  controller: AbortController,
  options: RequestInit = {},
) {
  return fetch(path, {
    ...options,
    cache: 'no-store',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
  });
}
function failure(status: number): string {
  if (status === 429)
    return 'Слишком много отправок. Подождите до часа и попробуйте снова. Текст сохранён в форме.';
  if (status === 401 || status === 403)
    return 'Не удалось подтвердить аккаунт. Войдите снова перед отправкой.';
  if (status === 404)
    return 'Вариант товара или отзыв больше недоступен. Обновите карточку перед повторной попыткой.';
  if (status === 400)
    return 'Проверьте оценку от 1 до 5 и текст от 20 до 4000 символов, затем отправьте снова.';
  return 'Сервис не подтвердил действие. Проверьте соединение и попробуйте снова. Текст сохранён в форме.';
}
function reviewStatus(review: CustomerReview): string {
  if (review.status === 'PENDING')
    return 'На модерации. Пока не влияет на рейтинг.';
  if (review.status === 'APPROVED')
    return 'Отзыв опубликован. После изменения он снова отправится на модерацию.';
  if (review.status === 'REJECTED')
    return 'Отзыв не опубликован. Измените текст и отправьте его снова.';
  return 'Отзыв удалён из публикации.';
}

/** Remount on identity changes so another account never sees stale private text. */
export function CustomerReviews({
  productVariantId,
  sessionEpoch = 0,
}: CustomerReviewsProps) {
  return (
    <CustomerReviewsWorkspace
      key={`${productVariantId}:${sessionEpoch}`}
      productVariantId={productVariantId}
    />
  );
}

function CustomerReviewsWorkspace({
  productVariantId,
}: {
  productVariantId: string;
}) {
  const id = useId();
  const [summary, setSummary] = useState<SummaryState>({ kind: 'LOADING' });
  const [identity, setIdentity] = useState<OwnState>({ kind: 'LOADING' });
  const [own, setOwn] = useState<CustomerReview | null>(null);
  const [stars, setStars] = useState(5);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [summaryEpoch, setSummaryEpoch] = useState(0);
  const [ownEpoch, setOwnEpoch] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const base = `/api/v1/products/${encodeURIComponent(productVariantId)}`;

  useEffect(() => {
    const controller = new AbortController();
    setSummary({ kind: 'LOADING' });
    void (async () => {
      try {
        const response = await request(`${base}/reviews?limit=20`, controller);
        const payload: unknown = response.ok ? await response.json() : null;
        if (!Value.Check(CustomerReviewSummaryResponseSchema, payload))
          throw new Error('Invalid summary');
        if (!controller.signal.aborted)
          setSummary({ kind: 'READY', summary: payload.summary });
      } catch {
        if (!controller.signal.aborted) setSummary({ kind: 'ERROR' });
      }
    })();
    return () => controller.abort();
  }, [base, summaryEpoch]);

  useEffect(() => {
    const controller = new AbortController();
    setIdentity({ kind: 'LOADING' });
    setOwn(null);
    setText('');
    setError(null);
    void (async () => {
      try {
        const response = await request('/api/v1/session', controller);
        const payload: unknown = response.ok ? await response.json() : null;
        if (!Value.Check(SessionResponseSchema, payload))
          throw new Error('Invalid session');
        if (controller.signal.aborted) return;
        if (payload.principal.kind !== 'ACCOUNT') {
          setIdentity({ kind: 'GUEST' });
          return;
        }
        const ownResponse = await request(`${base}/my-review`, controller);
        const ownPayload: unknown = ownResponse.ok
          ? await ownResponse.json()
          : null;
        if (!Value.Check(CustomerReviewOwnResponseSchema, ownPayload))
          throw new Error('Invalid own review');
        if (
          ownPayload.review &&
          ownPayload.review.productVariantId !== productVariantId
        )
          throw new Error('Review variant mismatch');
        const confirmedResponse = await request('/api/v1/session', controller);
        const confirmed: unknown = confirmedResponse.ok
          ? await confirmedResponse.json()
          : null;
        if (
          !Value.Check(SessionResponseSchema, confirmed) ||
          confirmed.principal.kind !== 'ACCOUNT' ||
          confirmed.principal.accountId !== payload.principal.accountId
        )
          throw new Error('Session changed while loading own review');
        if (controller.signal.aborted) return;
        setIdentity({
          kind: 'ACCOUNT',
          accountId: payload.principal.accountId,
        });
        const saved =
          ownPayload.review?.status === 'DELETED' ? null : ownPayload.review;
        setOwn(saved);
        setStars(saved?.stars ?? 5);
        setText(saved?.text ?? '');
      } catch {
        if (!controller.signal.aborted) setIdentity({ kind: 'ERROR' });
      }
    })();
    return () => controller.abort();
  }, [base, ownEpoch, productVariantId]);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const element = dialog.current;
    if (confirming) {
      if (!element?.open) element?.showModal();
    } else if (element?.open) {
      element.close();
      (deleteTrigger.current ?? textarea.current)?.focus();
    }
  }, [confirming]);

  function clearPrivateDraft() {
    setOwn(null);
    setText('');
    setStars(5);
    setConfirming(false);
    setIdentity({ kind: 'ERROR' });
  }

  async function mutate(method: 'PUT' | 'DELETE') {
    if (identity.kind !== 'ACCOUNT' || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const session = await request('/api/v1/session', controller);
      const principal: unknown = session.ok ? await session.json() : null;
      if (controller.signal.aborted) return;
      if (!Value.Check(SessionResponseSchema, principal))
        throw new Error(
          'Сессия не подтверждена. Проверьте соединение и попробуйте снова.',
        );
      if (
        principal.principal.kind !== 'ACCOUNT' ||
        principal.principal.accountId !== identity.accountId
      ) {
        clearPrivateDraft();
        throw new Error(
          'Аккаунт изменился. Проверьте сессию перед новым отзывом; действие не отправлено.',
        );
      }
      const response = await request(`${base}/my-review`, controller, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(
          method === 'PUT'
            ? { stars, text, expectedAccountId: identity.accountId }
            : { expectedAccountId: identity.accountId },
        ),
      });
      if (response.status === 401 || response.status === 403) {
        if (!controller.signal.aborted) clearPrivateDraft();
        throw new Error(
          'Аккаунт не подтверждён или изменился. Прежний черновик очищен; проверьте сессию.',
        );
      }
      if (!response.ok) throw new Error(failure(response.status));
      const payload: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (method === 'PUT') {
        if (
          !Value.Check(CustomerReviewWriteResponseSchema, payload) ||
          payload.review.productVariantId !== productVariantId
        )
          throw new Error(
            'Ответ не подтверждён. Обновите страницу, прежде чем повторять отправку.',
          );
        setOwn(payload.review);
        setStars(payload.review.stars);
        setText(payload.review.text);
        setMessage('Отзыв сохранён. Статус публикации указан над формой.');
      } else {
        if (!Value.Check(CustomerReviewDeleteResponseSchema, payload))
          throw new Error(
            'Удаление не подтверждено. Обновите страницу и проверьте отзыв.',
          );
        setOwn(null);
        setStars(5);
        setText('');
        setConfirming(false);
        setMessage('Отзыв удалён из публикации и больше не влияет на рейтинг.');
      }
      setSummaryEpoch((value) => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error && cause.name === 'Error'
            ? cause.message
            : 'Ответ не получен. Проверьте соединение и попробуйте снова. Текст сохранён в форме.',
        );
    } finally {
      if (mutation.current === controller && !controller.signal.aborted) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const length = Array.from(
      text.normalize('NFKC').trim().replace(/\s+/gu, ' '),
    ).length;
    if (length < 20 || length > 4000) {
      setError('Напишите от 20 до 4000 символов о своём опыте использования.');
      textarea.current?.focus();
      return;
    }
    void mutate('PUT');
  }

  return (
    <section
      className="private-product-workspace"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`}>Отзывы покупателей WTM</h3>
      <p>
        Источник — пользователи WhatTheMake. Покупки и email не подтверждены.
        Надёжность источника: низкая; отзывы не доказывают безопасность или
        эффективность.
      </p>
      {summary.kind === 'LOADING' && (
        <p role="status">Загружаем опубликованные отзывы…</p>
      )}
      {summary.kind === 'ERROR' && (
        <div role="alert">
          <p>
            Не удалось загрузить отзывы. Проверьте соединение и повторите
            запрос.
          </p>
          <button
            type="button"
            onClick={() => setSummaryEpoch((value) => value + 1)}
          >
            Повторить загрузку отзывов
          </button>
        </div>
      )}
      {summary.kind === 'READY' && (
        <>
          {summary.summary.ratingValue === null ? (
            <p>
              Опубликованных отзывов пока нет. Поделитесь опытом, чтобы помочь
              другим с выбором.
            </p>
          ) : (
            <p>
              <strong>
                {new Intl.NumberFormat('ru-RU', {
                  maximumFractionDigits: 2,
                }).format(summary.summary.ratingValue)}{' '}
                из 5
              </strong>
              . Опубликовано отзывов: {summary.summary.reviewCount}.
            </p>
          )}
          {summary.summary.asOf && (
            <p>
              Статистика обновлена:{' '}
              <time dateTime={summary.summary.asOf}>
                {new Intl.DateTimeFormat('ru-RU', {
                  dateStyle: 'medium',
                }).format(new Date(summary.summary.asOf))}
              </time>
              .
            </p>
          )}
          <CustomerReviewMentions
            mentions={summary.summary.mentions}
            anchorPrefix={`${id}-review-`}
          />
          <ol>
            {summary.summary.reviews.map((review) => (
              <li key={review.reviewId} id={`${id}-review-${review.reviewId}`}>
                <article>
                  <p>Оценка: {review.stars} из 5. Покупка не подтверждена.</p>
                  <p>{review.text}</p>
                  <small>
                    <time dateTime={review.createdAt}>
                      {new Intl.DateTimeFormat('ru-RU', {
                        dateStyle: 'medium',
                      }).format(new Date(review.createdAt))}
                    </time>
                  </small>
                </article>
              </li>
            ))}
          </ol>
        </>
      )}
      {identity.kind === 'LOADING' && (
        <p role="status">Проверяем возможность оставить отзыв…</p>
      )}
      {identity.kind === 'GUEST' && (
        <p>
          Чтобы оставить отзыв, войдите или создайте аккаунт в разделе «Аккаунт
          и личная история».
        </p>
      )}
      {identity.kind === 'ERROR' && (
        <div>
          <p role="alert">
            Не удалось подтвердить аккаунт для отзыва. Войдите и проверьте
            сессию снова.
          </p>
          <button
            type="button"
            onClick={() => setOwnEpoch((value) => value + 1)}
          >
            Проверить сессию для отзыва
          </button>
        </div>
      )}
      {identity.kind === 'ACCOUNT' && (
        <>
          {own && (
            <p role="status">
              {reviewStatus(own)}
              {own.duplicateText
                ? ' Текст похож на другой отзыв; нужна дополнительная проверка.'
                : ''}
            </p>
          )}
          <div className="inci-correction-card">
            <form
              onSubmit={submit}
              aria-busy={busy}
              aria-describedby={`${id}-help`}
            >
              <fieldset disabled={busy}>
                <legend>
                  {own ? 'Изменить свой отзыв' : 'Оставить свой отзыв'}
                </legend>
                <label htmlFor={`${id}-stars`}>
                  Ваша оценка
                  <select
                    id={`${id}-stars`}
                    value={stars}
                    onChange={(event) => setStars(Number(event.target.value))}
                  >
                    {[5, 4, 3, 2, 1].map((value) => (
                      <option key={value} value={value}>
                        {value} из 5
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor={`${id}-text`}>
                  Ваш опыт использования
                  <textarea
                    id={`${id}-text`}
                    ref={textarea}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    required
                    minLength={20}
                    maxLength={4000}
                    aria-describedby={`${id}-help`}
                  />
                </label>
              </fieldset>
              <p id={`${id}-help`}>
                20–4000 символов. Пишите только о своём опыте с этим вариантом.
                Не указывайте чужие персональные данные. Новый или изменённый
                отзыв не входит в рейтинг до модерации.
              </p>
              <button type="submit" disabled={busy}>
                {busy
                  ? 'Сохраняем отзыв…'
                  : own
                    ? 'Отправить изменения'
                    : 'Отправить отзыв на модерацию'}
              </button>
            </form>
          </div>
          {own && (
            <button
              type="button"
              ref={deleteTrigger}
              disabled={busy}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              Удалить свой отзыв
            </button>
          )}
        </>
      )}
      {error && !confirming && (
        <p className="comparison-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-delete-title`}
        aria-describedby={`${id}-delete-help`}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setConfirming(false);
        }}
      >
        <h3 id={`${id}-delete-title`}>Удалить свой отзыв?</h3>
        <p id={`${id}-delete-help`}>
          Отзыв исчезнет из публикации и рейтинга. История редакций останется
          для модерации. Позже можно отправить новый отзыв.
        </p>
        {error && confirming && <p role="alert">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Отмена
        </button>{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() => void mutate('DELETE')}
        >
          {busy ? 'Удаляем отзыв…' : 'Удалить отзыв из публикации'}
        </button>
      </dialog>
    </section>
  );
}
