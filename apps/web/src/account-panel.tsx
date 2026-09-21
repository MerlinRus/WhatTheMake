import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';
import { AccountSecurity } from './account-security.js';
import {
  SessionResponseSchema,
  PrivateProductListResponseSchema,
  type IdentityPrincipal,
  type PrivateProductSnapshot,
} from '@wtm/contracts';

export interface AccountPanelProps {
  onOpen(snapshot: PrivateProductSnapshot): void;
  onCompare(snapshot: PrivateProductSnapshot): void;
  onSessionChange(principal: IdentityPrincipal): void;
  refreshKey?: number;
}

type History =
  | { kind: 'LOADING' }
  | { kind: 'ERROR' }
  | { kind: 'READY'; snapshots: PrivateProductSnapshot[] };

function principalKey(principal: IdentityPrincipal): string {
  return principal.kind === 'ACCOUNT'
    ? `account:${principal.accountId}`
    : principal.kind === 'GUEST'
      ? `guest:${principal.guestId}`
      : 'anonymous';
}

function actionError(status: number): string {
  if (status === 401) return 'Не удалось войти. Проверьте email и пароль.';
  if (status === 409) return 'Этот email уже зарегистрирован. Выберите вход.';
  if (status === 429)
    return 'Слишком много попыток. Подождите и попробуйте снова.';
  if (status === 403)
    return 'Сессия изменилась или действие недоступно. Обновите сессию.';
  return 'Не удалось выполнить действие. Проверьте соединение и попробуйте снова.';
}

async function request(
  path: string,
  controller: AbortController,
  options: RequestInit = {},
) {
  try {
    return await fetch(path, {
      ...options,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    });
  } catch (cause) {
    if (controller.signal.aborted) throw cause;
    throw new Error(
      'Ответ не получен. Обновите сессию перед повторной попыткой.',
      { cause },
    );
  }
}

export function AccountPanel(props: AccountPanelProps) {
  const id = useId();
  const callbacks = useRef(props);
  callbacks.current = props;
  const identityKey = useRef<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [principal, setPrincipal] = useState<IdentityPrincipal | null>(null);
  const [history, setHistory] = useState<History>({ kind: 'LOADING' });
  const [mode, setMode] = useState<'REGISTER' | 'LOGIN'>('REGISTER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);

  function updatePrincipal(next: IdentityPrincipal) {
    setPrincipal(next);
    const nextKey = principalKey(next);
    if (identityKey.current !== nextKey) {
      identityKey.current = nextKey;
      callbacks.current.onSessionChange(next);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setHistory({ kind: 'LOADING' });
    void (async () => {
      try {
        const response = await request('/api/v1/session', controller, {
          cache: 'no-store',
        });
        if (!response.ok)
          throw new Error(
            'Не удалось проверить сессию. Попробуйте обновить её.',
          );
        const payload: unknown = await response.json();
        if (!Value.Check(SessionResponseSchema, payload))
          throw new Error(
            'Сервис вернул некорректную сессию. Попробуйте обновить её.',
          );
        if (controller.signal.aborted) return;
        updatePrincipal(payload.principal);
        if (payload.principal.kind === 'ANONYMOUS') {
          setHistory({ kind: 'READY', snapshots: [] });
          return;
        }
        try {
          const list = await request(
            '/api/v1/private-products?limit=30',
            controller,
            {
              cache: 'no-store',
            },
          );
          if (list.status === 401) {
            if (!controller.signal.aborted) {
              updatePrincipal({ kind: 'ANONYMOUS' });
              setHistory({ kind: 'READY', snapshots: [] });
            }
            return;
          }
          if (!list.ok) throw new Error('History unavailable');
          const data: unknown = await list.json();
          if (!Value.Check(PrivateProductListResponseSchema, data))
            throw new Error('Invalid history');
          if (!controller.signal.aborted)
            setHistory({ kind: 'READY', snapshots: data.snapshots });
        } catch {
          if (!controller.signal.aborted) setHistory({ kind: 'ERROR' });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          updatePrincipal({ kind: 'ANONYMOUS' });
          setPrincipal(null);
          setError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось проверить сессию.',
          );
          setHistory({ kind: 'ERROR' });
        }
      } finally {
        if (pending.current === controller && !controller.signal.aborted) {
          pending.current = null;
          setBusy(false);
        }
      }
    })();
    return () => controller.abort();
  }, [props.refreshKey, refresh]);

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const refreshOnFocus = () => {
      if (!pending.current) setRefresh((value) => value + 1);
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (deleting && principal?.kind === 'GUEST') element?.showModal();
    else if (element?.open) {
      element.close();
      deleteTrigger.current?.focus();
    }
  }, [deleting, principal?.kind]);

  async function mutate(
    action: 'REGISTER' | 'LOGIN' | 'LOGOUT' | 'DELETE_GUEST',
    form?: HTMLFormElement,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setMessage(null);
    const isAuth = action === 'REGISTER' || action === 'LOGIN';
    const fields = form ? new FormData(form) : null;
    const path =
      action === 'REGISTER'
        ? '/api/v1/accounts'
        : action === 'LOGIN'
          ? '/api/v1/account-sessions'
          : action === 'LOGOUT'
            ? '/api/v1/account-sessions/current'
            : '/api/v1/guest-sessions/current';
    try {
      if (action === 'DELETE_GUEST') {
        const current = await request('/api/v1/session', controller, {
          cache: 'no-store',
        });
        const payload: unknown = current.ok ? await current.json() : null;
        if (controller.signal.aborted) return;
        if (
          !Value.Check(SessionResponseSchema, payload) ||
          payload.principal.kind !== 'GUEST' ||
          principalKey(payload.principal) !== identityKey.current
        ) {
          setHistory({ kind: 'LOADING' });
          updatePrincipal({ kind: 'ANONYMOUS' });
          setDeleting(false);
          throw new Error(
            'Сессия изменилась. Обновите её перед удалением; ничего не удалено.',
          );
        }
      }
      const response = await request(path, controller, {
        method: isAuth ? 'POST' : 'DELETE',
        ...(isAuth
          ? {
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({
                email: String(fields?.get('email') ?? '').trim(),
                password: String(fields?.get('password') ?? ''),
              }),
            }
          : {}),
      });
      if (!response.ok) throw new Error(actionError(response.status));
      if (controller.signal.aborted) return;
      // Cookies may already have changed: discard old private rows before parsing.
      setHistory({ kind: 'LOADING' });
      updatePrincipal({ kind: 'ANONYMOUS' });
      if (isAuth) {
        const payload: unknown = await response.json();
        if (
          !Value.Check(SessionResponseSchema, payload) ||
          payload.principal.kind !== 'ACCOUNT'
        )
          throw new Error(
            'Вход не подтверждён. Обновите сессию перед продолжением.',
          );
        if (controller.signal.aborted) return;
        updatePrincipal(payload.principal);
        form?.reset();
      }
      setDeleting(false);
      setConfirmation('');
      setMessage(
        action === 'DELETE_GUEST'
          ? 'Гостевые данные удалены.'
          : action === 'LOGOUT'
            ? 'Вы вышли. Данные аккаунта сохранены.'
            : 'Вход выполнен. Загружаем личную историю.',
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось выполнить действие.',
        );
    } finally {
      const password = form?.elements.namedItem('password');
      if (password instanceof HTMLInputElement) password.value = '';
      if (pending.current === controller && !controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void mutate(mode, event.currentTarget);
  }

  return (
    <section
      className="comparison-workspace account-panel"
      aria-labelledby={`${id}-title`}
      aria-busy={busy}
    >
      <h2 id={`${id}-title`}>Аккаунт и личная история</h2>
      {busy && <p role="status">Обновляем сессию и данные…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="comparison-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Обновить сессию и историю
      </button>
      {principal?.kind === 'ACCOUNT' && (
        <>
          <p>Вы вошли: {principal.email}</p>
          <p>
            Выход не удаляет данные аккаунта. Вернуться к ним можно по email и
            паролю.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate('LOGOUT')}
          >
            Выйти из аккаунта
          </button>
        </>
      )}
      {principal?.kind === 'GUEST' && (
        <>
          <p>
            Гостевой доступ связан с cookie этого браузера. Очистка cookie лишит
            вас доступа. Регистрация или вход перенесут гостевые данные в
            аккаунт.
          </p>
          <button
            ref={deleteTrigger}
            type="button"
            className="comparison-error"
            disabled={busy}
            onClick={() => {
              setConfirmation('');
              setDeleting(true);
            }}
          >
            Удалить гостевые данные
          </button>
        </>
      )}
      {principal && principal.kind !== 'ACCOUNT' && (
        <>
          <fieldset className="comparison-mode" disabled={busy}>
            <legend>Доступ к аккаунту</legend>
            <label>
              <input
                type="radio"
                name={`${id}-mode`}
                checked={mode === 'REGISTER'}
                onChange={() => setMode('REGISTER')}
              />
              Регистрация
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-mode`}
                checked={mode === 'LOGIN'}
                onChange={() => setMode('LOGIN')}
              />
              Вход
            </label>
          </fieldset>
          <form onSubmit={authenticate}>
            <div className="comparison-preferences">
              <label htmlFor={`${id}-email`}>
                Email
                <input
                  id={`${id}-email`}
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                  disabled={busy}
                />
              </label>
              <label htmlFor={`${id}-password`}>
                Пароль
                <input
                  id={`${id}-password`}
                  name="password"
                  type="password"
                  autoComplete={
                    mode === 'REGISTER' ? 'new-password' : 'current-password'
                  }
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                  aria-describedby={`${id}-password-help`}
                />
              </label>
            </div>
            <p id={`${id}-password-help`}>
              От 12 до 128 символов. После входа создайте резервный код и
              сохраните его офлайн. Сброс пароля через email не предусмотрен.
            </p>
            {mode === 'REGISTER' && (
              <p>
                Подтверждение email не требуется. Проверьте адрес перед
                регистрацией.
              </p>
            )}
            <button className="compare-submit" type="submit" disabled={busy}>
              {mode === 'REGISTER' ? 'Создать аккаунт' : 'Войти'}
            </button>
          </form>
        </>
      )}
      {principal && principal.kind !== 'ANONYMOUS' && (
        <section aria-labelledby={`${id}-history`}>
          <h3 id={`${id}-history`}>Личная история</h3>
          {history.kind === 'LOADING' && (
            <p role="status">Загружаем карточки…</p>
          )}
          {history.kind === 'ERROR' && (
            <p role="alert">
              История не загрузилась. Нажмите «Обновить сессию и историю».
            </p>
          )}
          {history.kind === 'READY' && history.snapshots.length === 0 && (
            <p>
              Сохранённых карточек пока нет. Добавьте товар по упаковке и
              сохраните личную карточку.
            </p>
          )}
          {history.kind === 'READY' && history.snapshots.length > 0 && (
            <>
              <p>
                Показаны последние {history.snapshots.length} карточек, максимум
                30. Это ваши данные с упаковки, не подтверждение каталога.
              </p>
              <ul className="source-list">
                {history.snapshots.map((snapshot) => (
                  <li key={snapshot.snapshotId}>
                    <article
                      aria-label={`${snapshot.identity.brandName} ${snapshot.identity.familyName}`}
                    >
                      <h4>
                        {snapshot.identity.brandName} ·{' '}
                        {snapshot.identity.familyName}
                      </h4>
                      <p>
                        {snapshot.identity.variantName} · GTIN{' '}
                        {snapshot.barcode.value}
                      </p>
                      <time dateTime={snapshot.createdAt}>
                        {new Intl.DateTimeFormat('ru-RU', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(snapshot.createdAt))}
                      </time>
                      <p>
                        Источник: упаковка, подтверждена вами. Состав:{' '}
                        {snapshot.revision.source.kind === 'OCR'
                          ? 'распознан с фото'
                          : snapshot.revision.source.kind === 'USER_CORRECTION'
                            ? 'исправлен вручную'
                            : 'введён вручную'}
                        .
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => props.onOpen(snapshot)}
                      >
                        Открыть карточку
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => props.onCompare(snapshot)}
                      >
                        Сравнить эту карточку
                      </button>
                    </article>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {principal && (
        <AccountSecurity
          key={principalKey(principal)}
          principal={principal}
          disabled={busy}
          onSessionInvalidated={(notice) => {
            pending.current?.abort();
            pending.current = null;
            setHistory({ kind: 'LOADING' });
            updatePrincipal({ kind: 'ANONYMOUS' });
            setMessage(notice);
            setError(null);
            setRefresh((value) => value + 1);
          }}
        />
      )}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-delete-title`}
        aria-describedby={`${id}-delete-help`}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setDeleting(false);
        }}
      >
        <h3 id={`${id}-delete-title`}>Удалить гостевые данные и фотографии?</h3>
        <p id={`${id}-delete-help`}>
          Удалятся гостевая сессия, её фотографии, редакции состава и личные
          карточки. Это нельзя отменить. Данные аккаунта этой кнопкой не
          удаляются. Удаление файлов выполняется в фоне. Уже созданные резервные
          копии и общий технический кэш распознавания очищаются отдельно.
        </p>
        {error && deleting && <p role="alert">{error}</p>}
        <label htmlFor={`${id}-delete-confirm`}>
          Введите УДАЛИТЬ
          <input
            id={`${id}-delete-confirm`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => setDeleting(false)}
        >
          Отмена
        </button>{' '}
        <button
          className="comparison-error"
          type="button"
          disabled={busy || confirmation !== 'УДАЛИТЬ'}
          onClick={() => void mutate('DELETE_GUEST')}
        >
          Удалить гостевые данные и фотографии
        </button>
      </dialog>
    </section>
  );
}
