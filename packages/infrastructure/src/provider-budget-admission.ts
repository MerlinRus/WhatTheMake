import type {
  ProviderAdmission,
  ProviderAdmissionResult,
  ProviderBudgetOutcome,
  ProviderBudgetRepository,
  ProviderBudgetCompletion,
  BudgetProviderId,
} from '@wtm/domain';

type Admitted = Extract<ProviderAdmissionResult, { kind: 'ADMITTED' }>;

/** Accounting is best effort after admission: never delay an upstream result indefinitely. */
export async function completeProviderAdmission(
  admission: Admitted,
  completion: ProviderBudgetCompletion,
  timeoutMs = 250,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => admission.complete(completion))
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Late reservations remain charged, but can never authorize a late network dispatch. */
export function awaitProviderAdmission(
  admit: ProviderAdmission,
  provider: BudgetProviderId,
  signal?: AbortSignal,
  timeoutMs = 2_000,
): Promise<ProviderAdmissionResult> {
  if (signal?.aborted)
    return Promise.resolve({ kind: 'DENIED', reason: 'BUDGET_UNAVAILABLE' });
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProviderAdmissionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () =>
      finish({ kind: 'DENIED', reason: 'BUDGET_UNAVAILABLE' });
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => admit(provider))
      .then(
        (result) => {
          if (settled) {
            if (result.kind === 'ADMITTED')
              void completeProviderAdmission(result, {
                outcome: signal?.aborted ? 'ABORTED' : 'TIMEOUT',
                durationMs: Math.max(0, performance.now() - started),
              });
          } else finish(result);
        },
        () => finish({ kind: 'DENIED', reason: 'BUDGET_UNAVAILABLE' }),
      );
  });
}

export function createProviderBudgetAdmission(
  repository: Pick<ProviderBudgetRepository, 'reserve' | 'complete'>,
  options: { admissionTimeoutMs?: number; completionTimeoutMs?: number } = {},
): ProviderAdmission {
  const admit: ProviderAdmission = async (
    provider,
  ): Promise<ProviderAdmissionResult> => {
    try {
      const reservation = await repository.reserve(provider);
      if (reservation.kind === 'DENIED') return reservation;
      return {
        kind: 'ADMITTED',
        async complete(completion) {
          // A failed completion is an unresolved charged admission, never a refund.
          await completeProviderAdmission(
            {
              kind: 'ADMITTED',
              async complete(value) {
                await repository.complete(reservation.reservationId, value);
              },
            },
            completion,
            options.completionTimeoutMs ?? 250,
          );
        },
      };
    } catch {
      return { kind: 'DENIED', reason: 'BUDGET_UNAVAILABLE' };
    }
  };
  return (provider) =>
    awaitProviderAdmission(
      admit,
      provider,
      undefined,
      options.admissionTimeoutMs ?? 2_000,
    );
}

/** Fixed outcome categories only: never persist arbitrary provider error strings. */
export function providerBudgetOutcome(code?: string): ProviderBudgetOutcome {
  if (code === undefined) return 'SUCCEEDED';
  const outcomes: readonly ProviderBudgetOutcome[] = [
    'ABORTED',
    'TIMEOUT',
    'AUTHENTICATION_FAILED',
    'PERMISSION_DENIED',
    'RATE_LIMITED',
    'INVALID_REQUEST',
    'INVALID_RESPONSE',
    'PROVIDER_REJECTED',
    'PROVIDER_UNAVAILABLE',
  ];
  return (
    outcomes.find((outcome) => code.endsWith(`_${outcome}`)) ??
    'PROVIDER_UNAVAILABLE'
  );
}
