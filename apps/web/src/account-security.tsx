import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';
import {
  AccountRecoveryResponseSchema,
  RotateAccountRecoveryCodeResponseSchema,
  SessionResponseSchema,
  type IdentityPrincipal,
} from '@wtm/contracts';

interface AccountSecurityProps {
  principal: IdentityPrincipal;
  disabled?: boolean;
  onSessionInvalidated(message: string): void;
}

function failure(status: number): string {
  if (status === 401)
    return 'Не удалось подтвердить доступ. Проверьте пароль или email и резервный код.';
  if (status === 429)
    return 'Слишком много попыток. Подождите и попробуйте снова.';
  if (status === 403) return 'Действие недоступно в этой сессии. Обновите её.';
  return 'Ответ не получен или действие не выполнено. Обновите сессию перед повторной попыткой.';
}

function clearSecrets(form: HTMLFormElement | null): void {
  if (!form) return;
  for (const input of form.querySelectorAll<HTMLInputElement>(
    'input[type="password"], input[name="code"]',
  ))
    input.value = '';
}

export function AccountSecurity({
  principal,
  disabled = false,
  onSessionInvalidated,
}: AccountSecurityProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const pending = useRef<AbortController | null>(null);
  const codeForm = useRef<HTMLFormElement>(null);
  const resetForm = useRef<HTMLFormElement>(null);
  const deleteForm = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const callbacks = useRef(onSessionInvalidated);
  callbacks.current = onSessionInvalidated;
  const key =
    principal.kind === 'ACCOUNT'
      ? principal.accountId
      : principal.kind === 'GUEST'
        ? principal.guestId
        : 'anonymous';

  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
      clearSecrets(codeForm.current);
      clearSecrets(resetForm.current);
      clearSecrets(deleteForm.current);
    },
    [key],
  );
  useEffect(() => {
    if (!disabled) return;
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setRecoveryCode(null);
    setDeleting(false);
    setConfirmation('');
    clearSecrets(codeForm.current);
    clearSecrets(resetForm.current);
    clearSecrets(deleteForm.current);
  }, [disabled]);
  useEffect(() => {
    const element = dialog.current;
    if (deleting && principal.kind === 'ACCOUNT' && !disabled)
      element?.showModal();
    else if (element?.open) {
      element.close();
      deleteTrigger.current?.focus();
    }
  }, [deleting, principal.kind, disabled]);

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

  async function checkAccount(controller: AbortController): Promise<boolean> {
    const response = await request('/api/v1/session', controller);
    const data: unknown = response.ok ? await response.json() : null;
    if (controller.signal.aborted) return false;
    if (
      principal.kind !== 'ACCOUNT' ||
      !Value.Check(SessionResponseSchema, data) ||
      data.principal.kind !== 'ACCOUNT' ||
      data.principal.accountId !== principal.accountId
    ) {
      setRecoveryCode(null);
      setDeleting(false);
      setConfirmation('');
      callbacks.current(
        'Сессия изменилась. Ничего не удалено и резервный код не изменён. Проверьте аккаунт перед повторным действием.',
      );
      return false;
    }
    return true;
  }

  async function action(
    event: FormEvent<HTMLFormElement>,
    kind: 'ROTATE' | 'RESET' | 'DELETE',
  ) {
    event.preventDefault();
    if (pending.current || disabled) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '');
    setError(null);
    setMessage(null);
    if (kind === 'RESET' && text('newPassword') !== text('confirmPassword')) {
      setError('Новый пароль и повтор не совпадают.');
      return;
    }
    if (kind === 'DELETE' && confirmation !== 'УДАЛИТЬ') {
      setError('Введите УДАЛИТЬ, чтобы подтвердить удаление.');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    if (kind === 'ROTATE') setRecoveryCode(null);
    try {
      if (kind !== 'RESET' && !(await checkAccount(controller))) return;
      const path =
        kind === 'ROTATE'
          ? '/api/v1/accounts/current/recovery-code'
          : kind === 'RESET'
            ? '/api/v1/account-recovery'
            : '/api/v1/accounts/current';
      const body =
        kind === 'ROTATE'
          ? { currentPassword: text('currentPassword') }
          : kind === 'RESET'
            ? {
                email: text('email').trim(),
                code: text('code').trim(),
                newPassword: text('newPassword'),
              }
            : { password: text('password'), confirmation: 'DELETE' };
      const response = await request(path, controller, {
        method: kind === 'DELETE' ? 'DELETE' : 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(failure(response.status));
      if (controller.signal.aborted || pending.current !== controller) return;
      if (kind === 'DELETE') {
        if (response.status !== 204)
          throw new Error(
            'Удаление не подтверждено. Обновите сессию перед повторной попыткой.',
          );
        clearSecrets(form);
        setRecoveryCode(null);
        setDeleting(false);
        setConfirmation('');
        callbacks.current(
          'Аккаунт и личные данные удалены из доступа. Удаление файлов выполняется в фоне; действие нельзя отменить.',
        );
        return;
      }
      const payload: unknown = await response.json();
      if (controller.signal.aborted || pending.current !== controller) return;
      if (kind === 'ROTATE') {
        if (!Value.Check(RotateAccountRecoveryCodeResponseSchema, payload))
          throw new Error(
            'Код не получен. Повторное создание заменит предыдущий код.',
          );
        setRecoveryCode(payload.recoveryCode);
      } else {
        if (!Value.Check(AccountRecoveryResponseSchema, payload))
          throw new Error(
            'Смена пароля не подтверждена. Попробуйте войти с новым паролем.',
          );
        form.reset();
        setMessage(
          'Пароль изменён. Все сессии завершены, код использован. Войдите заново с новым паролем.',
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          cause instanceof Error &&
            cause.name !== 'TypeError' &&
            cause.name !== 'TimeoutError'
            ? cause.message
            : 'Ответ не получен. Проверьте сеть и обновите сессию перед повторной попыткой.',
        );
    } finally {
      clearSecrets(form);
      if (!controller.signal.aborted && pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section
      className="account-security"
      aria-labelledby={`${id}-title`}
      aria-busy={busy}
    >
      <h3 id={`${id}-title`}>
        {principal.kind === 'ACCOUNT'
          ? 'Защита и удаление аккаунта'
          : 'Восстановление по резервному коду'}
      </h3>
      <p>
        Восстановление доступно только по резервному коду, заранее созданному в
        аккаунте. Письма для сброса пароля не отправляются.
      </p>
      {busy && <p role="status">Проверяем доступ и выполняем действие…</p>}
      {message && <p role="status">{message}</p>}
      {error && !deleting && (
        <p className="comparison-error" role="alert">
          {error}
        </p>
      )}
      {principal.kind === 'ACCOUNT' ? (
        <>
          <p>
            Создание нового кода сразу отменяет предыдущий. Код показывается
            только сейчас; сохраните его вне этого браузера. Не передавайте его
            другим людям.
          </p>
          <form
            ref={codeForm}
            onSubmit={(event) => void action(event, 'ROTATE')}
          >
            <div className="comparison-preferences">
              <label>
                Текущий пароль для резервного кода
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy || disabled}
                />
              </label>
            </div>
            <button type="submit" disabled={busy || disabled}>
              Создать новый резервный код
            </button>
          </form>
          {recoveryCode && !disabled && (
            <section aria-label="Новый резервный код">
              <p role="status">
                Сохраните этот код офлайн. Сервер хранит только его хеш и не
                сможет показать код повторно.
              </p>
              <label>
                Ваш резервный код
                <input
                  value={recoveryCode}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <button type="button" onClick={() => setRecoveryCode(null)}>
                Я сохранил(а) код — скрыть
              </button>
            </section>
          )}
          <button
            ref={deleteTrigger}
            type="button"
            className="comparison-error"
            disabled={busy || disabled}
            onClick={() => {
              setConfirmation('');
              setError(null);
              setDeleting(true);
            }}
          >
            Удалить аккаунт и личные данные
          </button>
        </>
      ) : (
        <form ref={resetForm} onSubmit={(event) => void action(event, 'RESET')}>
          <fieldset
            className="comparison-preferences"
            disabled={busy || disabled}
          >
            <legend>Данные для восстановления</legend>
            <label>
              Email аккаунта для восстановления
              <input
                name="email"
                type="email"
                autoComplete="username"
                maxLength={254}
                required
              />
            </label>
            <label>
              Резервный код для восстановления
              <input
                name="code"
                type="password"
                autoComplete="off"
                maxLength={128}
                required
              />
            </label>
            <label>
              Новый пароль
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <label>
              Повторите новый пароль
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
          </fieldset>
          <p>
            Пароль: 12–128 символов. Код одноразовый. После восстановления
            потребуется обычный вход; новый резервный код можно создать в
            аккаунте.
          </p>
          <button type="submit" disabled={busy || disabled}>
            Сменить пароль по резервному коду
          </button>
        </form>
      )}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-delete-title`}
        aria-describedby={`${id}-delete-description`}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else {
            clearSecrets(deleteForm.current);
            setConfirmation('');
            setDeleting(false);
          }
        }}
      >
        <h3 id={`${id}-delete-title`}>
          Удалить аккаунт без возможности восстановления?
        </h3>
        <p id={`${id}-delete-description`}>
          Личные карточки, история, составы, предпочтения и доступ к фотографиям
          будут удалены. Сессии и резервный код перестанут работать. Удаление
          файлов выполняется в фоне. Это нельзя отменить. Удаление не
          затрагивает уже созданные резервные копии и общий технический кэш
          распознавания: они очищаются отдельно.
        </p>
        {error && deleting && <p role="alert">{error}</p>}
        <form
          ref={deleteForm}
          onSubmit={(event) => void action(event, 'DELETE')}
        >
          <div className="comparison-preferences">
            <label>
              Пароль для удаления аккаунта
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                minLength={12}
                maxLength={128}
                required
                disabled={busy || disabled}
              />
            </label>
            <label>
              Введите УДАЛИТЬ для аккаунта
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                disabled={busy || disabled}
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              clearSecrets(deleteForm.current);
              setConfirmation('');
              setDeleting(false);
            }}
          >
            Отмена
          </button>{' '}
          <button
            type="submit"
            className="comparison-error"
            disabled={busy || disabled || confirmation !== 'УДАЛИТЬ'}
          >
            Удалить аккаунт навсегда
          </button>
        </form>
      </dialog>
    </section>
  );
}
