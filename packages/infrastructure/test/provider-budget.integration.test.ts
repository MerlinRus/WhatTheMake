import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createPostgresProviderBudgetRepository } from '../src/provider-budget-repository.js';

const connectionString = process.env.TEST_DATABASE_URL;
test(
  'durable provider quotas enforce concurrent admission, restart, UTC days, completion and bounded retention',
  { skip: connectionString === undefined },
  async () => {
    assert.ok(connectionString);
    const schema = `budget_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString, max: 1 });
    let pool: Pool | undefined;
    let restarted: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        connectionString,
        max: 8,
        options: `-c search_path=${schema}`,
      });
      await pool.query(
        await readFile(
          resolve('apps/server/migrations/0020_provider_request_budgets.sql'),
          'utf8',
        ),
      );
      const dailyLimits = { GOOGLE_VISION: 3, DEEPSEEK: 0, UPCITEMDB: 100 };
      const repository = createPostgresProviderBudgetRepository(pool, {
        dailyLimits,
      });
      const other = createPostgresProviderBudgetRepository(pool, {
        dailyLimits,
      });
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? repository : other).reserve('GOOGLE_VISION'),
        ),
      );
      assert.equal(
        attempts.filter((entry) => entry.kind === 'ADMITTED').length,
        3,
      );
      assert.equal(
        attempts.filter((entry) => entry.kind === 'DENIED').length,
        9,
      );
      assert.deepEqual(await repository.reserve('DEEPSEEK'), {
        kind: 'DENIED',
        reason: 'BUDGET_EXHAUSTED',
      });
      const admitted = attempts.filter((entry) => entry.kind === 'ADMITTED');
      assert.equal(
        await repository.complete(admitted[0]!.reservationId, {
          outcome: 'SUCCEEDED',
          durationMs: 10.3,
        }),
        true,
      );
      assert.equal(
        await repository.complete(admitted[0]!.reservationId, {
          outcome: 'PROVIDER_UNAVAILABLE',
          durationMs: 80,
        }),
        false,
      );
      assert.equal(
        await repository.complete(admitted[1]!.reservationId, {
          outcome: 'TIMEOUT',
          durationMs: 100,
        }),
        true,
      );
      const summary = (await repository.summary()).find(
        (entry) => entry.provider === 'GOOGLE_VISION',
      );
      assert.ok(summary);
      assert.equal(summary.admittedCount, 3);
      assert.equal(summary.completedCount, 2);
      assert.equal(summary.unresolvedCount, 1);
      assert.equal(summary.durationTotalMs, 110);
      assert.deepEqual(summary.outcomes, { SUCCEEDED: 1, TIMEOUT: 1 });
      assert.ok(summary.lastSuccessAt instanceof Date);
      assert.deepEqual(await repository.reserve('GOOGLE_VISION'), {
        kind: 'DENIED',
        reason: 'BUDGET_EXHAUSTED',
      });

      await pool.end();
      pool = undefined;
      restarted = new Pool({
        connectionString,
        max: 4,
        options: `-c search_path=${schema}`,
      });
      const afterRestart = createPostgresProviderBudgetRepository(restarted, {
        dailyLimits: { ...dailyLimits, GOOGLE_VISION: 100 },
      });
      assert.deepEqual(await afterRestart.reserve('GOOGLE_VISION'), {
        kind: 'DENIED',
        reason: 'BUDGET_EXHAUSTED',
      });
      assert.equal(
        (await afterRestart.summary()).find(
          (entry) => entry.provider === 'GOOGLE_VISION',
        )?.requestLimit,
        3,
      );

      // Simulate a historical full day without altering the database clock: it never spends today's allocation.
      await restarted.query(
        "INSERT INTO wtm_provider_budget_state (provider, last_reserved_at) VALUES ('UPCITEMDB', clock_timestamp())",
      );
      await restarted.query(
        `INSERT INTO wtm_provider_budget_days VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1, 'UPCITEMDB', 100, 100)`,
      );
      // A fresh daily allocation must still respect a recent previous-day reservation.
      assert.deepEqual(await afterRestart.reserve('UPCITEMDB', 10_100), {
        kind: 'DENIED',
        reason: 'MINIMUM_INTERVAL',
      });
      await restarted.query(
        `UPDATE wtm_provider_budget_state SET last_reserved_at = clock_timestamp() - interval '11 seconds' WHERE provider = 'UPCITEMDB'`,
      );
      assert.equal(
        (await afterRestart.reserve('UPCITEMDB', 10_100)).kind,
        'ADMITTED',
      );
      assert.deepEqual(await afterRestart.reserve('UPCITEMDB', 10_100), {
        kind: 'DENIED',
        reason: 'MINIMUM_INTERVAL',
      });
      const afterSecondRestart = createPostgresProviderBudgetRepository(
        restarted,
        { dailyLimits },
      );
      assert.deepEqual(await afterSecondRestart.reserve('UPCITEMDB', 10_100), {
        kind: 'DENIED',
        reason: 'MINIMUM_INTERVAL',
      });
      // A database-clock rollback cannot reopen the spacing window.
      await restarted.query(
        `UPDATE wtm_provider_budget_state SET last_reserved_at = clock_timestamp() + interval '1 day' WHERE provider = 'UPCITEMDB'`,
      );
      assert.deepEqual(await afterSecondRestart.reserve('UPCITEMDB', 10_100), {
        kind: 'DENIED',
        reason: 'MINIMUM_INTERVAL',
      });
      await restarted.query(
        `UPDATE wtm_provider_budget_state SET last_reserved_at = clock_timestamp() - interval '11 seconds' WHERE provider = 'UPCITEMDB'`,
      );
      const spacing = await Promise.all(
        Array.from({ length: 5 }, () =>
          afterSecondRestart.reserve('UPCITEMDB', 10_100),
        ),
      );
      assert.equal(
        spacing.filter((entry) => entry.kind === 'ADMITTED').length,
        1,
      );
      const lowerLimit = createPostgresProviderBudgetRepository(restarted, {
        dailyLimits: { ...dailyLimits, UPCITEMDB: 1 },
      });
      assert.deepEqual(await lowerLimit.reserve('UPCITEMDB'), {
        kind: 'DENIED',
        reason: 'BUDGET_EXHAUSTED',
      });
      assert.equal(
        (await lowerLimit.summary()).find(
          (entry) => entry.provider === 'UPCITEMDB',
        )?.requestLimit,
        1,
      );

      await restarted.query(
        `INSERT INTO wtm_provider_budget_days VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 31, 'GOOGLE_VISION', 2000, 1200)`,
      );
      await restarted.query(`INSERT INTO wtm_provider_budget_reservations (budget_day, provider)
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 31, 'GOOGLE_VISION' FROM generate_series(1, 1200)`);
      assert.deepEqual(await afterRestart.purgeExpired(), {
        reservations: 1000,
        days: 0,
      });
      assert.deepEqual(await afterRestart.purgeExpired(), {
        reservations: 200,
        days: 1,
      });
      assert.equal(
        (await afterRestart.summary(30)).find(
          (entry) => entry.provider === 'GOOGLE_VISION',
        )?.admittedCount,
        3,
      );
      assert.equal(
        (
          await restarted.query(
            'SELECT count(*)::integer AS count FROM wtm_provider_budget_state',
          )
        ).rows[0].count,
        3,
      );
      await assert.rejects(afterRestart.reserve('GOOGLE_VISION', -1));
    } finally {
      await Promise.all([pool?.end(), restarted?.end()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
