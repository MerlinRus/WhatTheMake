/** Invocation quotas, not prices or provider billing records. */
export type BudgetProviderId = 'GOOGLE_VISION' | 'DEEPSEEK' | 'UPCITEMDB';
export type ProviderBudgetOutcome =
  | 'SUCCEEDED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNAVAILABLE';

export interface ProviderBudgetCompletion {
  outcome: ProviderBudgetOutcome;
  durationMs: number;
}

export type ProviderBudgetReservation =
  | { kind: 'ADMITTED'; reservationId: string }
  | { kind: 'DENIED'; reason: 'BUDGET_EXHAUSTED' | 'MINIMUM_INTERVAL' };

export interface ProviderBudgetDaySummary {
  day: string;
  provider: BudgetProviderId;
  requestLimit: number;
  admittedCount: number;
  completedCount: number;
  unresolvedCount: number;
  succeededCount: number;
  durationTotalMs: number;
  durationMaxMs: number;
  lastSuccessAt: Date | null;
  outcomes: Partial<Record<ProviderBudgetOutcome, number>>;
}

export interface ProviderBudgetRepository {
  reserve(
    provider: BudgetProviderId,
    minimumIntervalMs?: number,
  ): Promise<ProviderBudgetReservation>;
  complete(
    reservationId: string,
    completion: ProviderBudgetCompletion,
  ): Promise<boolean>;
  summary(days?: number): Promise<ProviderBudgetDaySummary[]>;
  /** One bounded batch; retains current UTC day and previous 29 UTC days. */
  purgeExpired(): Promise<{ reservations: number; days: number }>;
}

export type ProviderAdmissionResult =
  | {
      kind: 'ADMITTED';
      complete(completion: ProviderBudgetCompletion): Promise<void>;
    }
  | {
      kind: 'DENIED';
      reason: 'BUDGET_EXHAUSTED' | 'BUDGET_UNAVAILABLE' | 'MINIMUM_INTERVAL';
    };

/** Called only after local validation and immediately before a paid dispatch. */
export type ProviderAdmission = (
  provider: BudgetProviderId,
) => Promise<ProviderAdmissionResult>;
