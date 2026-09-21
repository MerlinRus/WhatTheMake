import { useEffect, useId, useRef, useState } from 'react';
import { Value } from 'typebox/value';
import {
  MascaraBriefInputSchema,
  MascaraBriefResponseSchema,
  MascaraPreferenceResponseSchema,
  SessionResponseSchema,
  type IdentityPrincipal,
  type MascaraBrief,
  type MascaraBriefInput,
  type MascaraGoal,
} from '@wtm/contracts';

interface Draft {
  mode: 'UNKNOWN_GOALS' | 'PERSONALIZED';
  goals: MascaraGoal[];
  waterproof: MascaraBriefInput['waterproof'];
  removal: MascaraBriefInput['removal'];
  sensitiveEyes: boolean;
  contactLenses: boolean;
  avoided: string;
}
const emptyDraft = (): Draft => ({
  mode: 'UNKNOWN_GOALS',
  goals: [],
  waterproof: 'NO_PREFERENCE',
  removal: 'NO_PREFERENCE',
  sensitiveEyes: false,
  contactLenses: false,
  avoided: '',
});
const goalOptions: ReadonlyArray<{ value: MascaraGoal; label: string }> = [
  { value: 'VOLUME', label: 'Объём' },
  { value: 'LENGTH', label: 'Удлинение' },
  { value: 'SEPARATION', label: 'Разделение' },
  { value: 'NATURAL_LOOK', label: 'Естественный эффект' },
];
function identityKey(principal: IdentityPrincipal): string {
  return principal.kind === 'ACCOUNT'
    ? `account:${principal.accountId}`
    : principal.kind === 'GUEST'
      ? `guest:${principal.guestId}`
      : 'anonymous';
}
function fromProfile(brief: MascaraBrief): Draft {
  return {
    mode: brief.mode,
    goals: [...brief.goals],
    waterproof: brief.waterproof,
    removal: brief.removal,
    sensitiveEyes: brief.sensitiveEyes,
    contactLenses: brief.contactLenses,
    avoided: brief.avoidedIngredients.join('\n'),
  };
}
async function request(
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  return fetch(path, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
}
async function session(signal: AbortSignal): Promise<IdentityPrincipal> {
  const response = await request('/api/v1/session', signal);
  const data: unknown = response.ok ? await response.json() : null;
  if (!Value.Check(SessionResponseSchema, data))
    throw new Error('Session unavailable');
  return data.principal;
}

/** Account profiles are loaded before enabling comparison; guest drafts stay in memory. */
export function useMascaraBrief(onInvalidate: () => void) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [phase, setPhase] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [profileVersion, setProfileVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const owner = useRef<string | null>(null);
  const generation = useRef(0);
  const edits = useRef(0);
  const savingRequest = useRef<AbortController | null>(null);
  const invalidation = useRef(onInvalidate);
  invalidation.current = onInvalidate;

  function changedSession() {
    ++generation.current;
    edits.current = 0;
    owner.current = null;
    savingRequest.current?.abort();
    savingRequest.current = null;
    setSaving(false);
    setDraft(emptyDraft());
    setAccountId(null);
    setProfileVersion(null);
    setMessage(null);
    setPhase('ERROR');
    setError(
      'Сессия изменилась. Прежние условия очищены. Загрузите условия заново.',
    );
    invalidation.current();
  }

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setPhase('LOADING');
    setError(null);
    void (async () => {
      try {
        const principal = await session(controller.signal);
        let profile: MascaraBrief | null = null;
        if (principal.kind === 'ACCOUNT') {
          const response = await request(
            '/api/v1/mascara-preferences/current',
            controller.signal,
          );
          const data: unknown = response.ok ? await response.json() : null;
          if (
            !Value.Check(MascaraPreferenceResponseSchema, data) ||
            (data.preference !== null &&
              data.preference.source !== 'ACCOUNT_PROFILE')
          )
            throw new Error('Profile unavailable');
          profile = data.preference;
          const confirmed = await session(controller.signal);
          if (identityKey(confirmed) !== identityKey(principal)) {
            if (!controller.signal.aborted && current === generation.current)
              changedSession();
            return;
          }
        }
        if (controller.signal.aborted || current !== generation.current) return;
        owner.current = identityKey(principal);
        edits.current = 0;
        setDraft(profile ? fromProfile(profile) : emptyDraft());
        setAccountId(principal.kind === 'ACCOUNT' ? principal.accountId : null);
        setProfileVersion(profile?.profileVersion ?? null);
        setMessage(null);
        setPhase('READY');
      } catch {
        if (!controller.signal.aborted && current === generation.current) {
          setPhase('ERROR');
          setError(
            'Не удалось загрузить условия. Сравнение остановлено, чтобы не пропустить сохранённые ограничения. Повторите загрузку.',
          );
        }
      }
    })();
    return () => controller.abort();
  }, [retry]);
  useEffect(
    () => () => {
      ++generation.current;
      savingRequest.current?.abort();
    },
    [],
  );

  function change(patch: Partial<Draft>) {
    ++edits.current;
    setDraft((previous) => ({ ...previous, ...patch }));
    setError(null);
    setMessage(null);
    invalidation.current();
  }

  function input(): MascaraBriefInput | null {
    const avoidedIngredients = draft.avoided
      .split(/\r\n|[\r\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (
      avoidedIngredients.length > 50 ||
      avoidedIngredients.some((item) => item.length > 128)
    ) {
      setError(
        'Укажите до 50 ингредиентов, каждое название — не длиннее 128 символов. Ничего не будет отброшено автоматически.',
      );
      return null;
    }
    const shared = {
      waterproof: draft.waterproof,
      removal: draft.removal,
      sensitiveEyes: draft.sensitiveEyes,
      contactLenses: draft.contactLenses,
      avoidedIngredients,
    };
    const brief: MascaraBriefInput =
      draft.mode === 'PERSONALIZED'
        ? { ...shared, mode: draft.mode, goals: [...draft.goals] }
        : { ...shared, mode: draft.mode };
    if (!Value.Check(MascaraBriefInputSchema, brief)) {
      setError(
        'Отметьте хотя бы один желаемый эффект или выберите «Не знаю — помогите выбрать».',
      );
      return null;
    }
    return brief;
  }

  async function currentSession(signal: AbortSignal): Promise<boolean> {
    const principal = await session(signal);
    if (signal.aborted) return false;
    if (identityKey(principal) !== owner.current) {
      changedSession();
      return false;
    }
    return true;
  }

  async function prepareComparison(
    signal: AbortSignal,
  ): Promise<MascaraBriefInput | null> {
    if (phase !== 'READY') return null;
    const value = input();
    if (!value) return null;
    const revision = edits.current;
    const current = generation.current;
    try {
      if (!(await currentSession(signal))) return null;
      if (
        signal.aborted ||
        current !== generation.current ||
        revision !== edits.current
      )
        return null;
      setError(null);
      return value;
    } catch {
      if (!signal.aborted && current === generation.current)
        setError(
          'Не удалось проверить сессию. Сравнение не отправлено; условия сохранены здесь. Попробуйте снова.',
        );
      return null;
    }
  }

  async function save() {
    if (phase !== 'READY' || accountId === null || savingRequest.current)
      return;
    const value = input();
    if (!value) return;
    const controller = new AbortController();
    savingRequest.current = controller;
    const current = generation.current;
    const revision = edits.current;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (!(await currentSession(controller.signal))) return;
      const response = await request(
        '/api/v1/mascara-preferences',
        controller.signal,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ ...value, expectedAccountId: accountId }),
        },
      );
      if (response.status === 401 || response.status === 403) {
        if (!controller.signal.aborted && current === generation.current)
          changedSession();
        return;
      }
      const data: unknown = response.ok ? await response.json() : null;
      if (
        !Value.Check(MascaraBriefResponseSchema, data) ||
        data.brief.source !== 'ACCOUNT_PROFILE'
      )
        throw new Error('Save unavailable');
      if (!(await currentSession(controller.signal))) return;
      if (controller.signal.aborted || current !== generation.current) return;
      setProfileVersion(data.brief.profileVersion);
      // Preserve edits made while this explicit save was in flight.
      if (revision === edits.current) setDraft(fromProfile(data.brief));
      setMessage(
        revision === edits.current
          ? 'Предпочтения сохранены в аккаунте.'
          : 'Предыдущие условия сохранены. Новые правки пока не сохранены в аккаунте.',
      );
    } catch {
      if (!controller.signal.aborted && current === generation.current)
        setError(
          'Сохранение не подтверждено. Введённые условия остались здесь. Проверьте соединение и повторите сохранение.',
        );
    } finally {
      if (savingRequest.current === controller) {
        savingRequest.current = null;
        setSaving(false);
      }
    }
  }

  return {
    draft,
    change,
    phase,
    accountId,
    profileVersion,
    saving,
    error,
    message,
    ready: phase === 'READY',
    prepareComparison,
    save,
    retry: () => setRetry((value) => value + 1),
  };
}

export function MascaraBriefEditor({
  brief,
}: {
  brief: ReturnType<typeof useMascaraBrief>;
}) {
  const id = useId();
  const { draft, change } = brief;
  return (
    <section aria-label="Условия выбора туши">
      {brief.phase === 'LOADING' && (
        <p role="status">Загружаем условия выбора…</p>
      )}
      {brief.error && (
        <p className="comparison-error" role="alert">
          {brief.error}
        </p>
      )}
      {brief.message && <p role="status">{brief.message}</p>}
      {brief.phase === 'ERROR' && (
        <button type="button" onClick={brief.retry}>
          Повторить загрузку условий
        </button>
      )}
      <fieldset disabled={!brief.ready}>
        <legend>Условия выбора</legend>
        <fieldset className="comparison-mode">
          <legend>Как выбирать тушь</legend>
          <label>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={draft.mode === 'UNKNOWN_GOALS'}
              onChange={() => change({ mode: 'UNKNOWN_GOALS' })}
            />
            Не знаю — помогите выбрать
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={draft.mode === 'PERSONALIZED'}
              onChange={() => change({ mode: 'PERSONALIZED' })}
            />
            У меня есть пожелания
          </label>
        </fieldset>
        <div className="comparison-preferences">
          {draft.mode === 'PERSONALIZED' && (
            <fieldset>
              <legend>Желаемый эффект</legend>
              {goalOptions.map((goal) => (
                <label key={goal.value}>
                  <input
                    type="checkbox"
                    checked={draft.goals.includes(goal.value)}
                    onChange={(event) =>
                      change({
                        goals: event.target.checked
                          ? [...draft.goals, goal.value]
                          : draft.goals.filter((value) => value !== goal.value),
                      })
                    }
                  />
                  {goal.label}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            Водостойкость для сравнения
            <select
              value={draft.waterproof}
              onChange={(event) =>
                change({
                  waterproof: event.target.value as Draft['waterproof'],
                })
              }
            >
              <option value="NO_PREFERENCE">Неважно</option>
              <option value="REQUIRED">Обязательно водостойкая</option>
              <option value="AVOID">Не нужна водостойкая</option>
            </select>
          </label>
          <label>
            Снятие для сравнения
            <select
              value={draft.removal}
              onChange={(event) =>
                change({ removal: event.target.value as Draft['removal'] })
              }
            >
              <option value="NO_PREFERENCE">Неважно</option>
              <option value="EASY_REQUIRED">Обязательно лёгкое снятие</option>
            </select>
          </label>
          <label>
            Исключить ингредиенты — каждый с новой строки
            <textarea
              value={draft.avoided}
              maxLength={6450}
              rows={3}
              autoComplete="off"
              onChange={(event) => change({ avoided: event.target.value })}
            />
          </label>
          <fieldset>
            <legend>Дополнительный контекст</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.sensitiveEyes}
                onChange={(event) =>
                  change({ sensitiveEyes: event.target.checked })
                }
              />
              Чувствительные глаза
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.contactLenses}
                onChange={(event) =>
                  change({ contactLenses: event.target.checked })
                }
              />
              Контактные линзы
            </label>
            <small>
              Укажем нехватку данных, но не будем обещать переносимость или
              медицинскую безопасность.
            </small>
          </fieldset>
        </div>
        <p>
          В режиме «Не знаю» ограничения продолжают действовать. Для этого
          сравнения их можно изменить явно.
        </p>
      </fieldset>
      {brief.ready &&
        (brief.accountId ? (
          <>
            <p>
              {brief.profileVersion === null
                ? 'Сохранённого профиля пока нет.'
                : `Загружена версия предпочтений ${brief.profileVersion}.`}{' '}
              Правки применяются к текущему сравнению; сохранение в аккаунте —
              отдельно.
            </p>
            <button
              type="button"
              disabled={brief.saving}
              onClick={() => void brief.save()}
            >
              {brief.saving
                ? 'Сохраняем предпочтения…'
                : 'Сохранить предпочтения в аккаунте'}
            </button>
          </>
        ) : (
          <p>
            Условия действуют только в этом разборе. Войдите в аккаунт, чтобы
            сохранять предпочтения.
          </p>
        ))}
    </section>
  );
}
