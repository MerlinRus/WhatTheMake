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
  googleVisionApiKey: string | null;
  googleVisionTimeoutMs: number;
  ocrQueueConcurrency: number;
  ocrQueueMaxPending: number;
  ocrQueueWaitTimeoutMs: number;
  ocrL1MaxEntries: number;
  ocrL1TtlMs: number;
  deepSeekEnabled: boolean;
  deepSeekApiKey: string | null;
  deepSeekTimeoutMs: number;
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

function booleanValue(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigurationError(`${name} must be true or false`);
}

function providerSecret(
  name: string,
  value: string | undefined,
  pattern: RegExp,
): string | null {
  if (value === undefined) return null;
  if (!pattern.test(value)) {
    throw new ConfigurationError(`${name} has invalid format`);
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
  const nodeEnvironment = enumValue(
    'NODE_ENV',
    environment.NODE_ENV ?? 'development',
    NODE_ENVIRONMENTS,
  );
  const googleVisionApiKey = providerSecret(
    'GOOGLE_VISION_API_KEY',
    environment.GOOGLE_VISION_API_KEY,
    /^AIza[A-Za-z0-9_-]{20,}$/,
  );
  const deepSeekEnabled = booleanValue(
    'DEEPSEEK_ENABLED',
    environment.DEEPSEEK_ENABLED,
    false,
  );
  const deepSeekApiKey = providerSecret(
    'DEEPSEEK_API_KEY',
    environment.DEEPSEEK_API_KEY,
    /^sk-[A-Za-z0-9_-]{20,}$/,
  );
  if (nodeEnvironment === 'production' && googleVisionApiKey === null) {
    throw new ConfigurationError(
      'GOOGLE_VISION_API_KEY is required in production',
    );
  }
  if (nodeEnvironment === 'production' && !deepSeekEnabled) {
    throw new ConfigurationError('DEEPSEEK_ENABLED must be true in production');
  }
  if (deepSeekEnabled && deepSeekApiKey === null) {
    throw new ConfigurationError(
      'DEEPSEEK_API_KEY is required when DeepSeek is enabled',
    );
  }

  return {
    nodeEnvironment,
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
    googleVisionApiKey,
    googleVisionTimeoutMs: integerInRange(
      'GOOGLE_VISION_TIMEOUT_MS',
      environment.GOOGLE_VISION_TIMEOUT_MS ?? '10000',
      1,
      60_000,
    ),
    ocrQueueConcurrency: integerInRange(
      'OCR_QUEUE_CONCURRENCY',
      environment.OCR_QUEUE_CONCURRENCY ?? '2',
      1,
      100,
    ),
    ocrQueueMaxPending: integerInRange(
      'OCR_QUEUE_MAX_PENDING',
      environment.OCR_QUEUE_MAX_PENDING ?? '20',
      0,
      10_000,
    ),
    ocrQueueWaitTimeoutMs: integerInRange(
      'OCR_QUEUE_WAIT_TIMEOUT_MS',
      environment.OCR_QUEUE_WAIT_TIMEOUT_MS ?? '15000',
      1,
      300_000,
    ),
    ocrL1MaxEntries: integerInRange(
      'OCR_L1_MAX_ENTRIES',
      environment.OCR_L1_MAX_ENTRIES ?? '128',
      0,
      100_000,
    ),
    ocrL1TtlMs: integerInRange(
      'OCR_L1_TTL_MS',
      environment.OCR_L1_TTL_MS ?? '300000',
      1,
      3_600_000,
    ),
    deepSeekEnabled,
    deepSeekApiKey,
    deepSeekTimeoutMs: integerInRange(
      'DEEPSEEK_TIMEOUT_MS',
      environment.DEEPSEEK_TIMEOUT_MS ?? '10000',
      1,
      60_000,
    ),
    version: nonEmpty(
      'npm_package_version',
      environment.npm_package_version ?? '0.1.0',
    ),
    buildSha: nonEmpty('BUILD_SHA', environment.BUILD_SHA ?? 'dev'),
  };
}
