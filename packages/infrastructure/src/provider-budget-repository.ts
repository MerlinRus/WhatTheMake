import type { Pool, PoolClient } from 'pg';
import type {
  BudgetProviderId,
  ProviderBudgetDaySummary,
  ProviderBudgetOutcome,
  ProviderBudgetRepository,
  ProviderBudgetReservation,
} from '@wtm/domain';
import { withTransaction } from './transaction.js';

const outcomes: readonly ProviderBudgetOutcome[] = [
  'SUCCEEDED',
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
const providers: readonly BudgetProviderId[] = [
  'GOOGLE_VISION',
  'DEEPSEEK',
  'UPCITEMDB',
];
const utcDay = "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date";

function withBudgetTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query(
      "SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '1500ms'",
    );
    return operation(client);
  });
}

export function createPostgresProviderBudgetRepository(
  pool: Pool,
  options: { dailyLimits: Readonly<Record<BudgetProviderId, number>> },
): ProviderBudgetRepository {
  const limits = { ...options.dailyLimits };
  for (const provider of providers) {
    if (
      !Number.isSafeInteger(limits[provider]) ||
      limits[provider] < 0 ||
      limits[provider] > 1_000_000
    )
      throw new Error(
        'Provider daily request limit must be an integer from 0 to 1000000',
      );
  }
  return {
    async reserve(provider, minimumIntervalMs = 0) {
      if (!providers.includes(provider))
        throw new Error('Invalid budget provider');
      if (
        !Number.isSafeInteger(minimumIntervalMs) ||
        minimumIntervalMs < 0 ||
        minimumIntervalMs > 60_000
      )
        throw new Error(
          'Provider minimum interval must be an integer from 0 to 60000',
        );
      return withBudgetTransaction<ProviderBudgetReservation>(
        pool,
        async (client) => {
          await client.query(
            'INSERT INTO wtm_provider_budget_state (provider) VALUES ($1) ON CONFLICT (provider) DO NOTHING',
            [provider],
          );
          // Lock survives day rollover: the minimum spacing is not reset at midnight.
          await client.query(
            'SELECT provider FROM wtm_provider_budget_state WHERE provider = $1 FOR UPDATE',
            [provider],
          );
          const timing = await client.query<{ allowed: boolean; day: string }>(
            `SELECT last_reserved_at IS NULL OR last_reserved_at <= clock_timestamp() - ($2::integer * interval '1 millisecond') AS allowed,
             to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
           FROM wtm_provider_budget_state WHERE provider = $1`,
            [provider, minimumIntervalMs],
          );
          const current = timing.rows[0];
          if (!current) throw new Error('Provider budget state was not found');
          if (!current.allowed)
            return { kind: 'DENIED', reason: 'MINIMUM_INTERVAL' };
          // This UPSERT locks one shared provider/day row across every application process.
          await client.query(
            `INSERT INTO wtm_provider_budget_days (budget_day, provider, request_limit)
           VALUES ($3::date, $1, $2)
           ON CONFLICT (budget_day, provider) DO UPDATE
           SET request_limit = LEAST(wtm_provider_budget_days.request_limit, EXCLUDED.request_limit)`,
            [provider, limits[provider], current.day],
          );
          const admitted = await client.query(
            `UPDATE wtm_provider_budget_days SET admitted_count = admitted_count + 1
           WHERE budget_day = $2::date AND provider = $1 AND admitted_count < request_limit
           RETURNING budget_day`,
            [provider, current.day],
          );
          if (admitted.rowCount !== 1)
            return { kind: 'DENIED', reason: 'BUDGET_EXHAUSTED' };
          const reservation = await client.query<{ id: string }>(
            `INSERT INTO wtm_provider_budget_reservations (budget_day, provider)
           VALUES ($2::date, $1) RETURNING id`,
            [provider, current.day],
          );
          const id = reservation.rows[0]?.id;
          if (!id)
            throw new Error('Provider budget reservation was not created');
          await client.query(
            'UPDATE wtm_provider_budget_state SET last_reserved_at = clock_timestamp() WHERE provider = $1',
            [provider],
          );
          return { kind: 'ADMITTED', reservationId: id };
        },
      );
    },
    async complete(reservationId, completion) {
      if (
        !outcomes.includes(completion.outcome) ||
        !Number.isFinite(completion.durationMs) ||
        completion.durationMs < 0
      )
        throw new Error('Invalid provider budget completion');
      const result = await withBudgetTransaction(pool, (client) =>
        client.query(
          `UPDATE wtm_provider_budget_reservations
         SET completed_at = clock_timestamp(), outcome = $2, duration_ms = $3
         WHERE id = $1 AND completed_at IS NULL`,
          [
            reservationId,
            completion.outcome,
            Math.min(3_600_000, Math.round(completion.durationMs)),
          ],
        ),
      );
      return result.rowCount === 1;
    },
    async summary(days = 1): Promise<ProviderBudgetDaySummary[]> {
      const bounded = Number.isFinite(days)
        ? Math.min(30, Math.max(1, Math.floor(days)))
        : 1;
      const result = await withBudgetTransaction(pool, (client) =>
        client.query<{
          day: string;
          provider: BudgetProviderId;
          request_limit: number;
          admitted_count: number;
          completed_count: number;
          succeeded_count: number;
          duration_total_ms: number;
          duration_max_ms: number;
          last_success_at: Date | null;
          outcomes: Partial<Record<ProviderBudgetOutcome, number>>;
        }>(
          `SELECT to_char(day.budget_day, 'YYYY-MM-DD') AS day, day.provider, day.request_limit, day.admitted_count,
          COALESCE(stats.completed_count, 0)::integer AS completed_count,
          COALESCE(stats.succeeded_count, 0)::integer AS succeeded_count,
          COALESCE(stats.duration_total_ms, 0)::double precision AS duration_total_ms,
          COALESCE(stats.duration_max_ms, 0)::integer AS duration_max_ms,
          stats.last_success_at, COALESCE(counts.outcomes, '{}'::jsonb) AS outcomes
         FROM wtm_provider_budget_days AS day
         LEFT JOIN LATERAL (
           SELECT count(completed_at) AS completed_count,
             count(*) FILTER (WHERE outcome = 'SUCCEEDED') AS succeeded_count,
             sum(duration_ms) AS duration_total_ms, max(duration_ms) AS duration_max_ms,
             max(completed_at) FILTER (WHERE outcome = 'SUCCEEDED') AS last_success_at
           FROM wtm_provider_budget_reservations
           WHERE budget_day = day.budget_day AND provider = day.provider
         ) AS stats ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_object_agg(outcome, count) AS outcomes FROM (
             SELECT outcome, count(*)::integer AS count FROM wtm_provider_budget_reservations
             WHERE budget_day = day.budget_day AND provider = day.provider AND outcome IS NOT NULL
             GROUP BY outcome
           ) AS grouped
         ) AS counts ON true
         WHERE day.budget_day BETWEEN ${utcDay} - ($1::integer - 1) AND ${utcDay}
         ORDER BY day.budget_day DESC, day.provider`,
          [bounded],
        ),
      );
      return result.rows.map((row) => ({
        day: row.day,
        provider: row.provider,
        requestLimit: row.request_limit,
        admittedCount: row.admitted_count,
        completedCount: row.completed_count,
        unresolvedCount: row.admitted_count - row.completed_count,
        succeededCount: row.succeeded_count,
        durationTotalMs: row.duration_total_ms,
        durationMaxMs: row.duration_max_ms,
        lastSuccessAt: row.last_success_at,
        outcomes: row.outcomes,
      }));
    },
    async purgeExpired() {
      return withBudgetTransaction(pool, async (client) => {
        const reservations = await client.query(
          `WITH expired AS (
             SELECT id FROM wtm_provider_budget_reservations WHERE budget_day < ${utcDay} - 29
             ORDER BY budget_day, id LIMIT 1000 FOR UPDATE SKIP LOCKED
           ) DELETE FROM wtm_provider_budget_reservations AS reservation USING expired
             WHERE reservation.id = expired.id`,
        );
        const days = await client.query(
          `WITH expired AS (
             SELECT budget_day, provider FROM wtm_provider_budget_days AS day
             WHERE budget_day < ${utcDay} - 29 AND NOT EXISTS (
               SELECT 1 FROM wtm_provider_budget_reservations AS reservation
               WHERE reservation.budget_day = day.budget_day AND reservation.provider = day.provider
             ) ORDER BY budget_day, provider LIMIT 100 FOR UPDATE SKIP LOCKED
           ) DELETE FROM wtm_provider_budget_days AS day USING expired
             WHERE day.budget_day = expired.budget_day AND day.provider = expired.provider`,
        );
        return {
          reservations: reservations.rowCount ?? 0,
          days: days.rowCount ?? 0,
        };
      });
    },
  };
}
