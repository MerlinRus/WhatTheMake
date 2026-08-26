import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Pool, type PoolConfig } from 'pg';

import type {
  CatalogRepository,
  CatalogImportRepository,
  IdentityRepository,
  MediaRepository,
  PreferencesRepository,
  ProductObservationRepository,
} from '@wtm/domain';

import { createPostgresCatalogRepository } from './catalog-repository.js';
import { createPostgresCatalogImportRepository } from './catalog-import-repository.js';
import type { OcrCacheStore } from './cached-ocr-provider.js';
import { createPostgresIdentityRepository } from './identity-repository.js';
import { createPostgresMediaRepository } from './media-repository.js';
import { createPostgresOcrCacheStore } from './ocr-cache-repository.js';
import { createPostgresPreferencesRepository } from './preferences-repository.js';
import { createPostgresProductObservationRepository } from './product-observation-repository.js';

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 928_042_025;
const CONNECTION_TIMEOUT_MS = 5_000;
const HEALTH_QUERY_TIMEOUT_MS = 3_000;

export type DatabaseStatus = 'UP' | 'DOWN';

export interface DatabaseHealth {
  status: DatabaseStatus;
  latencyMs: number;
}

export interface MigrationSummary {
  applied: string[];
  skipped: string[];
}

export interface DatabaseHealthProbe {
  health(): Promise<DatabaseHealth>;
}

export interface Database extends DatabaseHealthProbe {
  catalog: CatalogRepository;
  catalogImports: CatalogImportRepository;
  identity: IdentityRepository;
  media: MediaRepository;
  ocrCache: OcrCacheStore;
  preferences: PreferencesRepository;
  productObservations: ProductObservationRepository;
  migrate(migrationsDirectory: string): Promise<MigrationSummary>;
  close(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  connectionString: string;
  maxConnections: number;
  applicationName: string;
  onPoolError?: (error: Error) => void;
}

export class MigrationChecksumMismatchError extends Error {
  constructor(migrationName: string) {
    super(`Migration checksum changed after apply: ${migrationName}`);
    this.name = 'MigrationChecksumMismatchError';
  }
}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function poolConfig(options: PostgresDatabaseOptions): PoolConfig {
  return {
    connectionString: options.connectionString,
    max: options.maxConnections,
    application_name: options.applicationName,
    allowExitOnIdle: true,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  };
}

export function createPostgresDatabase(
  options: PostgresDatabaseOptions,
): Database {
  const pool = new Pool(poolConfig(options));
  const healthPool = new Pool({
    ...poolConfig(options),
    application_name: `${options.applicationName}-health`,
    max: 1,
    query_timeout: HEALTH_QUERY_TIMEOUT_MS,
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  healthPool.on('error', (error) => options.onPoolError?.(error));

  return {
    catalog: createPostgresCatalogRepository(pool),
    catalogImports: createPostgresCatalogImportRepository(pool),
    identity: createPostgresIdentityRepository(pool),
    media: createPostgresMediaRepository(pool),
    ocrCache: createPostgresOcrCacheStore(pool),
    preferences: createPostgresPreferencesRepository(pool),
    productObservations: createPostgresProductObservationRepository(pool),
    async health(): Promise<DatabaseHealth> {
      const startedAt = performance.now();
      try {
        await healthPool.query('SELECT 1');
        return {
          status: 'UP',
          latencyMs: roundMilliseconds(performance.now() - startedAt),
        };
      } catch {
        return {
          status: 'DOWN',
          latencyMs: roundMilliseconds(performance.now() - startedAt),
        };
      }
    },

    async migrate(migrationsDirectory: string): Promise<MigrationSummary> {
      const entries = await readdir(migrationsDirectory, {
        withFileTypes: true,
      });
      const migrationNames = entries
        .filter(
          (entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

      const client = await pool.connect();
      const summary: MigrationSummary = { applied: [], skipped: [] };

      try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        await client.query(`
          CREATE TABLE IF NOT EXISTS wtm_schema_migrations (
            name text PRIMARY KEY,
            checksum_sha256 char(64) NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `);

        for (const migrationName of migrationNames) {
          const sql = await readFile(
            join(migrationsDirectory, migrationName),
            'utf8',
          );
          const currentChecksum = checksum(sql);
          const existing = await client.query<{ checksum_sha256: string }>(
            'SELECT checksum_sha256 FROM wtm_schema_migrations WHERE name = $1',
            [migrationName],
          );

          if (existing.rowCount === 1) {
            if (existing.rows[0]?.checksum_sha256 !== currentChecksum) {
              throw new MigrationChecksumMismatchError(migrationName);
            }
            summary.skipped.push(migrationName);
            continue;
          }

          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query(
              'INSERT INTO wtm_schema_migrations (name, checksum_sha256) VALUES ($1, $2)',
              [migrationName, currentChecksum],
            );
            await client.query('COMMIT');
            summary.applied.push(migrationName);
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }

        return summary;
      } finally {
        await client
          .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
          .catch(() => {});
        client.release();
      }
    },

    async close(): Promise<void> {
      await Promise.all([pool.end(), healthPool.end()]);
    },
  };
}
