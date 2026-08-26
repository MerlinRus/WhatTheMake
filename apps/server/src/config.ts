import { isAbsolute, resolve } from 'node:path';

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

type LogLevel = (typeof LOG_LEVELS)[number];
type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export interface ServerConfig {
  nodeEnvironment: NodeEnvironment;
  host: string;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  databasePoolMax: number;
  publicOrigin: string;
  webRoot: string;
  migrationsDirectory: string;
  mediaRoot: string;
  mediaMaxBytes: number;
  mediaUploadRecoveryDelayMs: number;
  mediaRecoveryPollMs: number;
  mediaRecoveryLeaseMs: number;
  mediaRecoveryRetryBaseMs: number;
  mediaRecoveryRetryMaxMs: number;
  version: string;
  buildSha: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function enumValue<const Values extends readonly string[]>(
  name: string,
  value: string,
  allowed: Values,
): Values[number] {
  if (!allowed.includes(value)) {
    throw new ConfigurationError(
      `${name} must be one of: ${allowed.join(', ')}`,
    );
  }
  return value as Values[number];
}

function integerInRange(
  name: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function nonEmpty(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

function origin(name: string, value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== value ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
      throw new Error('not an origin');
    }
    return parsed.origin;
  } catch {
    throw new ConfigurationError(
      `${name} must be an http(s) origin without path`,
    );
  }
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv,
  currentWorkingDirectory = process.cwd(),
): ServerConfig {
  const migrationsValue =
    environment.MIGRATIONS_DIR ?? 'apps/server/migrations';
  const migrationsDirectory = isAbsolute(migrationsValue)
    ? migrationsValue
    : resolve(currentWorkingDirectory, migrationsValue);
  const mediaValue = environment.MEDIA_ROOT ?? 'data/media';
  const mediaRoot = isAbsolute(mediaValue)
    ? mediaValue
    : resolve(currentWorkingDirectory, mediaValue);
  const webValue = environment.WEB_ROOT ?? 'apps/web/dist';
  const webRoot = isAbsolute(webValue)
    ? webValue
    : resolve(currentWorkingDirectory, webValue);
  const mediaRecoveryRetryBaseMs = integerInRange(
    'MEDIA_RECOVERY_RETRY_BASE_MS',
    environment.MEDIA_RECOVERY_RETRY_BASE_MS ?? '5000',
    100,
    3_600_000,
  );
  const mediaRecoveryRetryMaxMs = integerInRange(
    'MEDIA_RECOVERY_RETRY_MAX_MS',
    environment.MEDIA_RECOVERY_RETRY_MAX_MS ?? '3600000',
    100,
    86_400_000,
  );
  if (mediaRecoveryRetryBaseMs > mediaRecoveryRetryMaxMs) {
    throw new ConfigurationError(
      'MEDIA_RECOVERY_RETRY_BASE_MS must not exceed MEDIA_RECOVERY_RETRY_MAX_MS',
    );
  }

  return {
    nodeEnvironment: enumValue(
      'NODE_ENV',
      environment.NODE_ENV ?? 'development',
      NODE_ENVIRONMENTS,
    ),
    host: nonEmpty('HOST', environment.HOST ?? '127.0.0.1'),
    port: integerInRange('PORT', environment.PORT ?? '8787', 1, 65_535),
    logLevel: enumValue(
      'LOG_LEVEL',
      environment.LOG_LEVEL ?? 'info',
      LOG_LEVELS,
    ),
    databaseUrl: nonEmpty('DATABASE_URL', environment.DATABASE_URL),
    databasePoolMax: integerInRange(
      'DATABASE_POOL_MAX',
      environment.DATABASE_POOL_MAX ?? '10',
      1,
      100,
    ),
    publicOrigin: origin(
      'PUBLIC_ORIGIN',
      environment.PUBLIC_ORIGIN ?? 'http://127.0.0.1:8787',
    ),
    webRoot,
    migrationsDirectory,
    mediaRoot,
    mediaMaxBytes: integerInRange(
      'MEDIA_MAX_BYTES',
      environment.MEDIA_MAX_BYTES ?? String(8 * 1024 * 1024),
      1,
      8 * 1024 * 1024,
    ),
    mediaUploadRecoveryDelayMs: integerInRange(
      'MEDIA_UPLOAD_RECOVERY_DELAY_MS',
      environment.MEDIA_UPLOAD_RECOVERY_DELAY_MS ?? '60000',
      1_000,
      3_600_000,
    ),
    mediaRecoveryPollMs: integerInRange(
      'MEDIA_RECOVERY_POLL_MS',
      environment.MEDIA_RECOVERY_POLL_MS ?? '1000',
      100,
      60_000,
    ),
    mediaRecoveryLeaseMs: integerInRange(
      'MEDIA_RECOVERY_LEASE_MS',
      environment.MEDIA_RECOVERY_LEASE_MS ?? '30000',
      1_000,
      3_600_000,
    ),
    mediaRecoveryRetryBaseMs,
    mediaRecoveryRetryMaxMs,
    version: nonEmpty(
      'npm_package_version',
      environment.npm_package_version ?? '0.1.0',
    ),
    buildSha: nonEmpty('BUILD_SHA', environment.BUILD_SHA ?? 'dev'),
  };
}
