import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import {
  INCI_LOOKUP_NORMALIZER_VERSION,
  serializeInciDictionarySnapshot,
  type CanonicalIngredientId,
  type IngredientKnowledgeSnapshotId,
  type IngredientKnowledgeVersion,
  type InciDictionaryAliasId,
  type InciDictionarySnapshot,
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
  'ingredient knowledge requires evidence, preserves conflict, and versions changes',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 2,
      applicationName: 'wtm-ingredient-knowledge-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const ingredientId = randomUUID();
    const firstSnapshotId = randomUUID();
    const firstFactId = randomUUID();
    const supportId = randomUUID();
    const conflictId = randomUUID();
    const firstVersion = `knowledge-${randomUUID().replaceAll('-', '')}`;

    try {
      await database.migrate(resolve('apps/server/migrations'));
      await adminPool.query(`
        TRUNCATE
          wtm_ingredient_fact_evidence_links,
          wtm_ingredient_fact_evidence,
          wtm_ingredient_function_facts,
          wtm_ingredient_knowledge_snapshots,
          wtm_inci_ingredients
        CASCADE
      `);
      assert.equal(
        await database.ingredientKnowledge.findPublishedSnapshot(),
        null,
      );

      await adminPool.query(
        'INSERT INTO wtm_inci_ingredients (id) VALUES ($1)',
        [ingredientId],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_knowledge_snapshots (id, version)
          VALUES ($1, $2)
        `,
        [firstSnapshotId, firstVersion],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_function_facts (
            id,
            snapshot_id,
            ingredient_id,
            function_code,
            jurisdiction,
            confidence
          )
          VALUES ($1, $2, $3, 'FILM_FORMER', 'GLOBAL', 'MEDIUM')
        `,
        [firstFactId, firstSnapshotId, ingredientId],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_fact_evidence (
            id,
            snapshot_id,
            evidence_type,
            source_url,
            checked_at
          )
          VALUES
            ($1, $3, 'OFFICIAL_DATABASE', 'https://authority.example/fact', '2026-08-25T09:00:00.000Z'),
            ($2, $3, 'SCIENTIFIC_PUBLICATION', 'https://research.example/conflict', '2026-08-26T09:00:00.000Z')
        `,
        [supportId, conflictId, firstSnapshotId],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_fact_evidence_links (
            snapshot_id,
            fact_id,
            evidence_id,
            stance
          )
          VALUES ($1, $2, $3, 'CONTRADICTS')
        `,
        [firstSnapshotId, firstFactId, conflictId],
      );

      await assert.rejects(
        adminPool.query(
          `
            UPDATE wtm_ingredient_knowledge_snapshots
            SET status = 'PUBLISHED', published_at = $2
            WHERE id = $1
          `,
          [firstSnapshotId, new Date('2026-08-27T09:00:00.000Z')],
        ),
        /Published ingredient facts require supporting evidence/,
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_fact_evidence_links (
            snapshot_id,
            fact_id,
            evidence_id,
            stance
          )
          VALUES ($1, $2, $3, 'SUPPORTS')
        `,
        [firstSnapshotId, firstFactId, supportId],
      );
      await adminPool.query(
        `
          UPDATE wtm_ingredient_knowledge_snapshots
          SET status = 'PUBLISHED', published_at = $2
          WHERE id = $1
        `,
        [firstSnapshotId, new Date('2026-08-27T09:00:00.000Z')],
      );

      const firstPublished =
        await database.ingredientKnowledge.findPublishedSnapshot();
      assert.ok(firstPublished);
      assert.equal(
        firstPublished.snapshotId,
        firstSnapshotId as IngredientKnowledgeSnapshotId,
      );
      assert.equal(
        firstPublished.version,
        firstVersion as IngredientKnowledgeVersion,
      );
      assert.deepEqual(
        firstPublished.facts[0]?.evidence.map(({ stance }) => stance),
        ['SUPPORTS', 'CONTRADICTS'],
      );
      await assert.rejects(
        adminPool.query(
          `
            UPDATE wtm_ingredient_function_facts
            SET confidence = 'HIGH'
            WHERE id = $1
          `,
          [firstFactId],
        ),
        /Published ingredient knowledge is immutable/,
      );

      const secondSnapshotId = randomUUID();
      const secondFactId = randomUUID();
      const secondEvidenceId = randomUUID();
      const secondVersion = `knowledge-${randomUUID().replaceAll('-', '')}`;
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_knowledge_snapshots (
            id,
            version,
            based_on_snapshot_id
          )
          VALUES ($1, $2, $3)
        `,
        [secondSnapshotId, secondVersion, firstSnapshotId],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_function_facts (
            id,
            snapshot_id,
            ingredient_id,
            function_code,
            jurisdiction,
            confidence
          )
          VALUES ($1, $2, $3, 'FILM_FORMER', 'GLOBAL', 'HIGH')
        `,
        [secondFactId, secondSnapshotId, ingredientId],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_fact_evidence (
            id,
            snapshot_id,
            evidence_type,
            source_url,
            checked_at
          )
          VALUES (
            $1,
            $2,
            'REGULATORY_ASSESSMENT',
            'https://authority.example/reassessment',
            '2026-08-27T10:00:00.000Z'
          )
        `,
        [secondEvidenceId, secondSnapshotId],
      );
      await adminPool.query(
        `
          INSERT INTO wtm_ingredient_fact_evidence_links (
            snapshot_id,
            fact_id,
            evidence_id,
            stance
          )
          VALUES ($1, $2, $3, 'SUPPORTS')
        `,
        [secondSnapshotId, secondFactId, secondEvidenceId],
      );
      await adminPool.query(
        `
          UPDATE wtm_ingredient_knowledge_snapshots
          SET status = 'RETIRED', retired_at = '2026-08-27T11:00:00.000Z'
          WHERE id = $1
        `,
        [firstSnapshotId],
      );
      await adminPool.query(
        `
          UPDATE wtm_ingredient_knowledge_snapshots
          SET status = 'PUBLISHED', published_at = '2026-08-27T11:00:00.000Z'
          WHERE id = $1
        `,
        [secondSnapshotId],
      );

      const secondPublished =
        await database.ingredientKnowledge.findPublishedSnapshot();
      assert.ok(secondPublished);
      assert.equal(
        secondPublished.snapshotId,
        secondSnapshotId as IngredientKnowledgeSnapshotId,
      );
      assert.equal(
        secondPublished.basedOnSnapshotId,
        firstSnapshotId as IngredientKnowledgeSnapshotId,
      );
      const history = await adminPool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM wtm_ingredient_knowledge_snapshots',
      );
      assert.equal(history.rows[0]?.count, 2);
    } finally {
      await database.close();
      await adminPool.end();
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
    const contentSha256 = 'd'.repeat(64);

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
            normalizer_version,
            content_sha256
          )
          VALUES ($1, $2, $3, $4)
        `,
        [
          snapshotId,
          dictionaryVersion,
          INCI_LOOKUP_NORMALIZER_VERSION,
          contentSha256,
        ],
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
      await assert.rejects(
        adminPool.query(
          `
            UPDATE wtm_inci_dictionary_snapshots
            SET status = 'RETIRED', retired_at = now(), content_sha256 = $1
            WHERE id = $2
          `,
          ['e'.repeat(64), snapshotId],
        ),
        /Published INCI dictionary snapshots are immutable/,
      );
    } finally {
      await database.close();
      await adminPool.end();
    }
  },
);

test(
  'INCI dictionary publication is atomic, idempotent, and checksum-bound',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 2,
      applicationName: 'wtm-inci-dictionary-publication-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const version = `publish-${randomUUID().replaceAll('-', '')}`;
    const ingredientId = randomUUID();
    const aliasId = randomUUID();
    const snapshot: InciDictionarySnapshot = {
      dictionaryVersion: version as InciDictionaryVersion,
      normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
      ingredients: [
        {
          ingredientId: ingredientId as CanonicalIngredientId,
          canonicalName: 'Aqua',
          canonicalLookupKey: 'aqua',
          aliases: [
            {
              aliasId: aliasId as InciDictionaryAliasId,
              aliasText: 'Water',
              lookupKey: 'water',
            },
          ],
        },
      ],
    };
    const contentSha256 = createHash('sha256')
      .update(serializeInciDictionarySnapshot(snapshot), 'utf8')
      .digest('hex');
    const input = { snapshot, contentSha256 };

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

      const missingChecksumSnapshotId = randomUUID();
      await adminPool.query(
        `
          INSERT INTO wtm_inci_dictionary_snapshots (
            id,
            version,
            normalizer_version
          )
          VALUES ($1, $2, $3)
        `,
        [
          missingChecksumSnapshotId,
          `missing-checksum-${randomUUID().replaceAll('-', '')}`,
          INCI_LOOKUP_NORMALIZER_VERSION,
        ],
      );
      await assert.rejects(
        adminPool.query(
          `
            UPDATE wtm_inci_dictionary_snapshots
            SET status = 'PUBLISHED', published_at = now()
            WHERE id = $1
          `,
          [missingChecksumSnapshotId],
        ),
        /Published INCI dictionary checksum is required/,
      );
      await adminPool.query(
        'DELETE FROM wtm_inci_dictionary_snapshots WHERE id = $1',
        [missingChecksumSnapshotId],
      );

      assert.deepEqual(
        await database.inciDictionary.previewPublication(input),
        {
          kind: 'READY',
          dictionaryVersion: version,
          contentSha256,
          counts: { ingredients: 1, aliases: 1 },
        },
      );
      assert.deepEqual(await database.inciDictionary.publish(input), {
        kind: 'PUBLISHED',
        dictionaryVersion: version,
        contentSha256,
        counts: { ingredients: 1, aliases: 1 },
      });
      assert.deepEqual(
        await database.inciDictionary.findPublishedSnapshot(),
        snapshot,
      );
      assert.deepEqual(await database.inciDictionary.publish(input), {
        kind: 'ALREADY_PUBLISHED',
        dictionaryVersion: version,
        contentSha256,
        counts: { ingredients: 1, aliases: 1 },
      });

      const rows = await adminPool.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM wtm_inci_dictionary_snapshots
      `);
      assert.equal(rows.rows[0]?.count, 1);
      const nextSnapshot = {
        ...snapshot,
        dictionaryVersion: `${version}-next` as InciDictionaryVersion,
      };
      const nextContentSha256 = createHash('sha256')
        .update(serializeInciDictionarySnapshot(nextSnapshot), 'utf8')
        .digest('hex');
      const conflict = await database.inciDictionary.previewPublication({
        snapshot: nextSnapshot,
        contentSha256: nextContentSha256,
      });
      assert.deepEqual(conflict, {
        kind: 'VERSION_CONFLICT',
        dictionaryVersion: `${version}-next`,
        contentSha256: nextContentSha256,
        counts: { ingredients: 1, aliases: 1 },
        existingVersion: version,
        existingContentSha256: contentSha256,
      });
      await assert.rejects(
        database.inciDictionary.publish({
          snapshot,
          contentSha256: 'f'.repeat(64),
        }),
        /content checksum does not match snapshot/,
      );
      await assert.rejects(
        database.inciDictionary.previewPublication({
          snapshot,
          contentSha256: 'f'.repeat(64),
        }),
        /content checksum does not match snapshot/,
      );
      await assert.rejects(
        adminPool.query(
          `
            UPDATE wtm_inci_dictionary_snapshots
            SET content_sha256 = $1
            WHERE version = $2
          `,
          ['c'.repeat(64), version],
        ),
        /Published INCI dictionary snapshots are immutable/,
      );
    } finally {
      await database.close();
      await adminPool.end();
    }
  },
);
