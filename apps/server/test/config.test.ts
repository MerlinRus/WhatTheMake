import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { ConfigurationError, loadServerConfig } from '../src/config.js';

test('server config validates and resolves external input', () => {
  const config = loadServerConfig(
    {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '9000',
      LOG_LEVEL: 'debug',
      DATABASE_URL: 'postgresql://example.test/wtm',
      DATABASE_POOL_MAX: '4',
      PUBLIC_ORIGIN: 'https://whatthemake.test',
      MIGRATIONS_DIR: 'migrations',
      MEDIA_ROOT: 'private-media',
      WEB_ROOT: 'web-dist',
      MEDIA_MAX_BYTES: '1048576',
      MEDIA_UPLOAD_RECOVERY_DELAY_MS: '15000',
      MEDIA_RECOVERY_POLL_MS: '500',
      MEDIA_RECOVERY_LEASE_MS: '10000',
      MEDIA_RECOVERY_RETRY_BASE_MS: '250',
      MEDIA_RECOVERY_RETRY_MAX_MS: '30000',
      GOOGLE_VISION_API_KEY: `AIza${'a'.repeat(32)}`,
      GOOGLE_VISION_TIMEOUT_MS: '9000',
      OCR_QUEUE_CONCURRENCY: '3',
      OCR_QUEUE_MAX_PENDING: '30',
      OCR_QUEUE_WAIT_TIMEOUT_MS: '12000',
      OCR_L1_MAX_ENTRIES: '64',
      OCR_L1_TTL_MS: '120000',
      DEEPSEEK_ENABLED: 'true',
      DEEPSEEK_API_KEY: `sk-${'b'.repeat(32)}`,
      DEEPSEEK_TIMEOUT_MS: '8000',
      BUILD_SHA: 'test-sha',
      npm_package_version: '0.1.0',
    },
    'C:\\workspace',
  );

  assert.equal(config.port, 9000);
  assert.equal(config.databasePoolMax, 4);
  assert.equal(config.nodeEnvironment, 'test');
  assert.equal(config.publicOrigin, 'https://whatthemake.test');
  assert.equal(
    config.migrationsDirectory,
    resolve('C:\\workspace', 'migrations'),
  );
  assert.equal(config.mediaRoot, resolve('C:\\workspace', 'private-media'));
  assert.equal(config.webRoot, resolve('C:\\workspace', 'web-dist'));
  assert.equal(config.mediaMaxBytes, 1_048_576);
  assert.equal(config.mediaUploadRecoveryDelayMs, 15_000);
  assert.equal(config.mediaRecoveryPollMs, 500);
  assert.equal(config.mediaRecoveryLeaseMs, 10_000);
  assert.equal(config.mediaRecoveryRetryBaseMs, 250);
  assert.equal(config.mediaRecoveryRetryMaxMs, 30_000);
  assert.equal(config.googleVisionTimeoutMs, 9_000);
  assert.equal(config.ocrQueueConcurrency, 3);
  assert.equal(config.ocrQueueMaxPending, 30);
  assert.equal(config.ocrQueueWaitTimeoutMs, 12_000);
  assert.equal(config.ocrL1MaxEntries, 64);
  assert.equal(config.ocrL1TtlMs, 120_000);
  assert.equal(config.deepSeekEnabled, true);
  assert.equal(config.deepSeekTimeoutMs, 8_000);
});

test('server config requires DATABASE_URL', () => {
  assert.throws(() => loadServerConfig({}), ConfigurationError);
});

test('server config rejects invalid numeric and enum values', () => {
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        PORT: '0',
      }),
    /PORT must be between/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        LOG_LEVEL: 'everything',
      }),
    /LOG_LEVEL must be one of/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        PUBLIC_ORIGIN: 'https://whatthemake.test/path',
      }),
    /PUBLIC_ORIGIN must be an http\(s\) origin without path/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        MEDIA_MAX_BYTES: '8388609',
      }),
    /MEDIA_MAX_BYTES must be between/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        MEDIA_RECOVERY_RETRY_BASE_MS: '1000',
        MEDIA_RECOVERY_RETRY_MAX_MS: '500',
      }),
    /MEDIA_RECOVERY_RETRY_BASE_MS must not exceed/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        DEEPSEEK_ENABLED: 'sometimes',
      }),
    /DEEPSEEK_ENABLED must be true or false/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        DATABASE_URL: 'postgresql://example.test/wtm',
        GOOGLE_VISION_API_KEY: 'not-a-key',
      }),
    /GOOGLE_VISION_API_KEY has invalid format/,
  );
});

test('production config requires both provider keys without exposing values', () => {
  const databaseUrl = 'postgresql://example.test/wtm';
  assert.throws(
    () =>
      loadServerConfig({
        NODE_ENV: 'production',
        DATABASE_URL: databaseUrl,
      }),
    /GOOGLE_VISION_API_KEY is required in production/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        NODE_ENV: 'production',
        DATABASE_URL: databaseUrl,
        GOOGLE_VISION_API_KEY: `AIza${'a'.repeat(32)}`,
      }),
    /DEEPSEEK_ENABLED must be true in production/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        NODE_ENV: 'production',
        DATABASE_URL: databaseUrl,
        GOOGLE_VISION_API_KEY: `AIza${'a'.repeat(32)}`,
        DEEPSEEK_ENABLED: 'true',
      }),
    /DEEPSEEK_API_KEY is required when DeepSeek is enabled/,
  );
});
