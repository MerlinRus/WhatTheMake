import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import {
  INCI_LOOKUP_NORMALIZER_VERSION,
  type CanonicalIngredientId,
  type InciDictionaryAliasId,
  type InciDictionaryVersion,
} from '@wtm/domain';

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

test(
  'published INCI dictionary preserves aliases, ambiguity, and immutability',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 2,
      applicationName: 'wtm-inci-dictionary-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const snapshotId = randomUUID();
    const ingredientIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    const aliasIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    const dictionaryVersion = `fixture-${randomUUID().replaceAll('-', '')}`;

    try {
      await database.migrate(resolve('apps/server/migrations'));
      await adminPool.query(`
        TRUNCATE
          wtm_inci_dictionary_aliases,
          wtm_inci_dictionary_entries,
          wtm_inci_dictionary_snapshots,
          wtm_inci_ingredients
        CASCADE
      `);
      assert.equal(await database.inciDictionary.findPublishedSnapshot(), null);

      await adminPool.query(
        `
          INSERT INTO wtm_inci_dictionary_snapshots (
            id,
            version,
            normalizer_version
          )
          VALUES ($1, $2, $3)
        `,
        [snapshotId, dictionaryVersion, INCI_LOOKUP_NORMALIZER_VERSION],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_inci_ingredients (id)
          VALUES ($1), ($2), ($3)
        `,
        ingredientIds,
      );
      await adminPool.query(
        `
          INSERT INTO wtm_inci_dictionary_entries (
            snapshot_id,
            ingredient_id,
            canonical_name,
            canonical_lookup_key
          )
          VALUES
            ($1, $2, 'Aqua', 'aqua'),
            ($1, $3, 'Cera Alba', 'cera alba'),
            ($1, $4, 'Copernicia Cerifera Cera', 'copernicia cerifera cera')
        `,
        [snapshotId, ...ingredientIds],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_inci_dictionary_aliases (
            id,
            snapshot_id,
            ingredient_id,
            alias_text,
            lookup_key
          )
          VALUES
            ($1, $4, $5, 'Water', 'water'),
            ($2, $4, $6, 'Wax', 'wax'),
            ($3, $4, $7, 'Wax', 'wax')
        `,
        [...aliasIds, snapshotId, ...ingredientIds],
      );
      await adminPool.query(
        `
          UPDATE wtm_inci_dictionary_snapshots
          SET status = 'PUBLISHED', published_at = now()
          WHERE id = $1
        `,
        [snapshotId],
      );

      assert.deepEqual(await database.inciDictionary.findPublishedSnapshot(), {
        dictionaryVersion: dictionaryVersion as InciDictionaryVersion,
        normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
        ingredients: [
          {
            ingredientId: ingredientIds[0] as CanonicalIngredientId,
            canonicalName: 'Aqua',
            canonicalLookupKey: 'aqua',
            aliases: [
              {
                aliasId: aliasIds[0] as InciDictionaryAliasId,
                aliasText: 'Water',
                lookupKey: 'water',
              },
            ],
          },
          {
            ingredientId: ingredientIds[1] as CanonicalIngredientId,
            canonicalName: 'Cera Alba',
            canonicalLookupKey: 'cera alba',
            aliases: [
              {
                aliasId: aliasIds[1] as InciDictionaryAliasId,
                aliasText: 'Wax',
                lookupKey: 'wax',
              },
            ],
          },
          {
            ingredientId: ingredientIds[2] as CanonicalIngredientId,
            canonicalName: 'Copernicia Cerifera Cera',
            canonicalLookupKey: 'copernicia cerifera cera',
            aliases: [
              {
                aliasId: aliasIds[2] as InciDictionaryAliasId,
                aliasText: 'Wax',
                lookupKey: 'wax',
              },
            ],
          },
        ],
      });
      await assert.rejects(
        adminPool.query(
          'UPDATE wtm_inci_dictionary_aliases SET alias_text = $1 WHERE id = $2',
          ['Changed after publish', aliasIds[0]],
        ),
        /Published INCI dictionary snapshots are immutable/,
      );
    } finally {
      await database.close();
      await adminPool.end();
    }
  },
);
