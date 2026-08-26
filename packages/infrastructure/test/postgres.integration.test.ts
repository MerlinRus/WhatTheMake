import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPostgresDatabase,
  MigrationChecksumMismatchError,
} from '../src/index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  'PostgreSQL migrations are idempotent and checksum protected',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 2,
      applicationName: 'wtm-integration-test',
    });
    const directory = await mkdtemp(join(tmpdir(), 'wtm-migrations-'));
    const migrationName = `9999_test_${randomUUID().replaceAll('-', '')}.sql`;
    const migrationPath = join(directory, migrationName);

    try {
      await writeFile(migrationPath, 'SELECT 1;\n', 'utf8');
      const first = await database.migrate(directory);
      const second = await database.migrate(directory);

      assert.deepEqual(first.applied, [migrationName]);
      assert.deepEqual(second.skipped, [migrationName]);

      await writeFile(migrationPath, 'SELECT 2;\n', 'utf8');
      await assert.rejects(
        database.migrate(directory),
        MigrationChecksumMismatchError,
      );
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
