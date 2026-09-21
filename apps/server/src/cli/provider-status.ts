import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BudgetProviderId,
  ProviderBudgetDaySummary,
  ProviderBudgetOutcome,
} from '@wtm/domain';
import { createPostgresDatabase } from '@wtm/infrastructure';
import { loadServerConfig } from '../config.js';

const providers: readonly BudgetProviderId[] = [
  'GOOGLE_VISION',
  'DEEPSEEK',
  'UPCITEMDB',
];
const outcomeCodes: readonly ProviderBudgetOutcome[] = [
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
type WarningCode =
  | 'BUDGET_NEAR_LIMIT'
  | 'BUDGET_EXHAUSTED'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'REPEATED_FAILURES';

export function parseProviderStatusArgs(args: readonly string[]): {
  maintain: boolean;
} {
  if (
    args.some((arg) => arg !== '--maintain' && arg !== '--json') ||
    new Set(args).size !== args.length
  )
    throw new Error('Use optional --maintain and --json only');
  return { maintain: args.includes('--maintain') };
}

/** Passive database observations only: no provider credentials or live API probes. */
export function createProviderStatusReport(input: {
  enabled: Readonly<Record<BudgetProviderId, boolean>>;
  configuredLimits: Readonly<Record<BudgetProviderId, number>>;
  summaries: readonly ProviderBudgetDaySummary[];
  now: Date;
  maintenance?: { reservations: number; days: number };
}) {
  const warnings: Array<{ provider: BudgetProviderId; code: WarningCode }> = [];
  const entries = providers.map((provider) => {
    const summary = input.summaries.find(
      (entry) => entry.provider === provider,
    );
    const cap = Math.min(
      input.configuredLimits[provider],
      summary?.requestLimit ?? input.configuredLimits[provider],
    );
    const admittedCount = summary?.admittedCount ?? 0;
    const completedCount = summary?.completedCount ?? 0;
    const succeededCount = summary?.succeededCount ?? 0;
    const outcomes: Partial<Record<ProviderBudgetOutcome, number>> = {};
    for (const code of outcomeCodes) {
      const count = summary?.outcomes[code] ?? 0;
      if (count > 0) outcomes[code] = count;
    }
    const failedCount = completedCount - succeededCount;
    const providerFailureCount = failedCount - (outcomes.ABORTED ?? 0);
    if (input.enabled[provider]) {
      if (cap === 0 || admittedCount >= cap)
        warnings.push({ provider, code: 'BUDGET_EXHAUSTED' });
      else if (admittedCount / cap >= 0.8)
        warnings.push({ provider, code: 'BUDGET_NEAR_LIMIT' });
    }
    if (outcomes.AUTHENTICATION_FAILED)
      warnings.push({ provider, code: 'AUTHENTICATION_FAILED' });
    if (outcomes.PERMISSION_DENIED)
      warnings.push({ provider, code: 'PERMISSION_DENIED' });
    if (providerFailureCount >= 3)
      warnings.push({ provider, code: 'REPEATED_FAILURES' });
    return {
      provider,
      enabled: input.enabled[provider],
      applicationUsage:
        provider === 'DEEPSEEK'
          ? ('DORMANT_NO_CUSTOMER_CALLER' as const)
          : ('CUSTOMER_PATH_CONNECTED' as const),
      evidence:
        admittedCount === 0
          ? ('NO_ADMISSIONS_TODAY' as const)
          : ('RECORDED_ADMISSIONS' as const),
      day: summary?.day ?? null,
      requestLimit: cap,
      remainingRequests: Math.max(0, cap - admittedCount),
      admittedCount,
      completedCount,
      succeededCount,
      failedCount,
      unresolvedCount: summary?.unresolvedCount ?? 0,
      outcomes,
      meanRecordedDurationMs:
        completedCount === 0
          ? null
          : Math.round((summary?.durationTotalMs ?? 0) / completedCount),
      maximumRecordedDurationMs:
        completedCount === 0 ? null : (summary?.durationMaxMs ?? null),
      lastSuccessAt: summary?.lastSuccessAt?.toISOString() ?? null,
      monetaryCost: null,
    };
  });
  return {
    schemaVersion: 1 as const,
    kind: 'PROVIDER_STATUS' as const,
    status: warnings.length > 0 ? ('WARN' as const) : ('OK' as const),
    generatedAt: input.now.toISOString(),
    window: 'CURRENT_DATABASE_UTC_DAY' as const,
    monitoringMode: 'PASSIVE_NO_EXTERNAL_PROBES' as const,
    monetaryCost: null,
    providers: entries,
    warnings,
    maintenance: input.maintenance
      ? {
          reservations: input.maintenance.reservations,
          days: input.maintenance.days,
        }
      : null,
  };
}

async function main(): Promise<void> {
  const command = parseProviderStatusArgs(process.argv.slice(2));
  const config = loadServerConfig(process.env);
  const dailyLimits = {
    GOOGLE_VISION: config.googleVisionDailyRequestLimit,
    DEEPSEEK: config.deepSeekDailyRequestLimit,
    UPCITEMDB: 100,
  };
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 1,
    applicationName: 'wtm-provider-status',
    providerDailyLimits: dailyLimits,
  });
  try {
    const maintenance = command.maintain
      ? await database.providerBudget.purgeExpired()
      : undefined;
    const report = createProviderStatusReport({
      enabled: {
        GOOGLE_VISION: config.googleVisionApiKey !== null,
        DEEPSEEK: config.deepSeekEnabled,
        UPCITEMDB: config.upcItemDbEnabled,
      },
      configuredLimits: dailyLimits,
      summaries: await database.providerBudget.summary(1),
      now: new Date(),
      ...(maintenance ? { maintenance } : {}),
    });
    console.info(JSON.stringify(report));
    process.exitCode = report.status === 'WARN' ? 2 : 0;
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch {
    console.error(
      JSON.stringify({
        kind: 'CHECK_FAILED',
        message:
          'Provider status check failed; check deployment configuration and database availability.',
      }),
    );
    process.exitCode = 1;
  }
}
