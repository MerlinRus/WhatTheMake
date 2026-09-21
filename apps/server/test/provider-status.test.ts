import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderBudgetDaySummary } from '@wtm/domain';
import {
  createProviderStatusReport,
  parseProviderStatusArgs,
} from '../src/cli/provider-status.js';

const now = new Date('2026-09-20T12:00:00.000Z');
const defaults = {
  enabled: { GOOGLE_VISION: true, DEEPSEEK: true, UPCITEMDB: true },
  configuredLimits: { GOOGLE_VISION: 100, DEEPSEEK: 50, UPCITEMDB: 100 },
  now,
};
function summary(
  values: Partial<ProviderBudgetDaySummary> = {},
): ProviderBudgetDaySummary {
  return {
    day: '2026-09-20',
    provider: 'GOOGLE_VISION',
    requestLimit: 100,
    admittedCount: 10,
    completedCount: 10,
    unresolvedCount: 0,
    succeededCount: 10,
    durationTotalMs: 1000,
    durationMaxMs: 200,
    lastSuccessAt: now,
    outcomes: { SUCCEEDED: 10 },
    ...values,
  };
}

test('provider status parses only explicit bounded switches', () => {
  assert.deepEqual(parseProviderStatusArgs([]), { maintain: false });
  assert.deepEqual(parseProviderStatusArgs(['--json', '--maintain']), {
    maintain: true,
  });
  for (const args of [
    ['--maintain', '--maintain'],
    ['--days', '100'],
    ['--key=secret'],
  ])
    assert.throws(() => parseProviderStatusArgs(args));
});

test('empty evidence is not reported as healthy paid integration or zero monetary cost', () => {
  const result = createProviderStatusReport({ ...defaults, summaries: [] });
  assert.equal(result.status, 'OK');
  assert.equal(result.monetaryCost, null);
  assert.equal(result.providers.length, 3);
  assert.ok(
    result.providers.every(
      (entry) =>
        entry.evidence === 'NO_ADMISSIONS_TODAY' &&
        entry.monetaryCost === null &&
        entry.lastSuccessAt === null,
    ),
  );
  assert.equal(
    result.providers.find((entry) => entry.provider === 'DEEPSEEK')
      ?.applicationUsage,
    'DORMANT_NO_CUSTOMER_CALLER',
  );
});

test('quota warnings start exactly at eighty percent and never show negative remaining requests', () => {
  assert.equal(
    createProviderStatusReport({
      ...defaults,
      summaries: [summary({ admittedCount: 79 })],
    }).status,
    'OK',
  );
  const nearing = createProviderStatusReport({
    ...defaults,
    summaries: [summary({ admittedCount: 80 })],
  });
  assert.deepEqual(nearing.warnings, [
    { provider: 'GOOGLE_VISION', code: 'BUDGET_NEAR_LIMIT' },
  ]);
  const exhausted = createProviderStatusReport({
    ...defaults,
    summaries: [summary({ admittedCount: 100 })],
    configuredLimits: { ...defaults.configuredLimits, GOOGLE_VISION: 50 },
  });
  assert.equal(exhausted.providers[0]?.remainingRequests, 0);
  assert.deepEqual(exhausted.warnings, [
    { provider: 'GOOGLE_VISION', code: 'BUDGET_EXHAUSTED' },
  ]);
});

test('stored lower quota remains effective after raising deployment configuration', () => {
  const result = createProviderStatusReport({
    ...defaults,
    summaries: [summary({ requestLimit: 10, admittedCount: 8 })],
  });
  assert.equal(result.providers[0]?.requestLimit, 10);
  assert.equal(result.providers[0]?.remainingRequests, 2);
  assert.equal(result.status, 'WARN');
});

test('auth and permission errors warn once; repeated failures exclude caller aborts', () => {
  const result = createProviderStatusReport({
    ...defaults,
    summaries: [
      summary({
        succeededCount: 7,
        outcomes: {
          SUCCEEDED: 7,
          AUTHENTICATION_FAILED: 1,
          PERMISSION_DENIED: 1,
          TIMEOUT: 1,
        },
      }),
    ],
  });
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'REPEATED_FAILURES'],
  );
  const aborts = createProviderStatusReport({
    ...defaults,
    summaries: [
      summary({ succeededCount: 7, outcomes: { SUCCEEDED: 7, ABORTED: 3 } }),
    ],
  });
  assert.equal(aborts.status, 'OK');
});

test('unresolved is reported without declaring hung requests or provider failure', () => {
  const result = createProviderStatusReport({
    ...defaults,
    summaries: [
      summary({
        completedCount: 0,
        succeededCount: 0,
        unresolvedCount: 10,
        durationTotalMs: 0,
        durationMaxMs: 0,
        lastSuccessAt: null,
        outcomes: {},
      }),
    ],
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.providers[0]?.unresolvedCount, 10);
  assert.equal(result.providers[0]?.meanRecordedDurationMs, null);
  assert.equal(JSON.stringify(result).includes('HUNG'), false);
});

test('disabled zero-cap provider does not warn; enabled zero-cap provider does', () => {
  const configuredLimits = { ...defaults.configuredLimits, GOOGLE_VISION: 0 };
  assert.equal(
    createProviderStatusReport({
      ...defaults,
      configuredLimits,
      enabled: { ...defaults.enabled, GOOGLE_VISION: false },
      summaries: [],
    }).status,
    'OK',
  );
  assert.equal(
    createProviderStatusReport({ ...defaults, configuredLimits, summaries: [] })
      .status,
    'WARN',
  );
});

test('report explicitly whitelists metadata and never copies unexpected source strings', () => {
  const input = {
    ...defaults,
    summaries: [
      {
        ...summary(),
        credential: 'secret-sentinel',
        outcomes: { SUCCEEDED: 10, private_input: 'input-sentinel' },
      },
    ],
    maintenance: { reservations: 1000, days: 2 },
  };
  const result = createProviderStatusReport(input);
  assert.equal(result.providers[0]?.meanRecordedDurationMs, 100);
  assert.equal(result.providers[0]?.maximumRecordedDurationMs, 200);
  assert.deepEqual(result.maintenance, { reservations: 1000, days: 2 });
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
});
