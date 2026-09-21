import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createPostgresDatabase } from '@wtm/infrastructure';
import { prepareInciDictionaryPublication } from '../src/inci-dictionary/service.js';
import { prepareIngredientKnowledgePublication } from '../src/ingredient-knowledge/publication.js';

const dictionary = prepareInciDictionaryPublication(
  readFileSync(
    new URL('../seeds/inci/dictionary.json', import.meta.url),
    'utf8',
  ),
);
const raw = readFileSync(
  new URL('../seeds/ingredient-knowledge/functions.json', import.meta.url),
  'utf8',
);
const publishedAt = new Date('2026-09-21T00:00:00.000Z');

test('knowledge seed requires exact dictionary identities and supporting evidence', () => {
  const prepared = prepareIngredientKnowledgePublication(
    raw,
    dictionary.snapshot,
    publishedAt,
  );
  assert.equal(prepared.facts.length, 2);
  assert.ok(
    prepared.facts.every(
      (fact) => fact.functionCode === 'COLORANT' && fact.jurisdiction === 'US',
    ),
  );
  assert.deepEqual(
    prepared,
    prepareIngredientKnowledgePublication(
      raw,
      dictionary.snapshot,
      publishedAt,
    ),
  );
  assert.throws(
    () =>
      prepareIngredientKnowledgePublication(
        raw.replace('"MICA"', '"Guessed Ingredient"'),
        dictionary.snapshot,
        publishedAt,
      ),
    /identity/,
  );
  assert.throws(
    () =>
      prepareIngredientKnowledgePublication(
        raw.replaceAll('"SUPPORTS"', '"CONTRADICTS"'),
        dictionary.snapshot,
        publishedAt,
      ),
    /MISSING_SUPPORTING_EVIDENCE/,
  );
  assert.throws(
    () =>
      prepareIngredientKnowledgePublication(
        raw.replaceAll('https://www.fda.gov', 'javascript:alert'),
        dictionary.snapshot,
        publishedAt,
      ),
    /shape/,
  );
  assert.throws(
    () =>
      prepareIngredientKnowledgePublication(
        raw,
        dictionary.snapshot,
        new Date('2026-09-19T00:00:00.000Z'),
      ),
    /EVIDENCE_CHECKED_AFTER_PUBLICATION/,
  );
  assert.throws(
    () =>
      prepareIngredientKnowledgePublication(
        ' '.repeat(256 * 1024 + 1),
        dictionary.snapshot,
        publishedAt,
      ),
    /256 KiB/,
  );
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
test(
  'knowledge initial publication is dry-run safe, atomic, idempotent and conflict preserving',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 3,
      applicationName: 'wtm-knowledge-publication-test',
    });
    const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    try {
      await database.migrate(resolve('apps/server/migrations'));
      await admin.query(
        'TRUNCATE wtm_ingredient_fact_evidence_links, wtm_ingredient_fact_evidence, wtm_ingredient_function_facts, wtm_ingredient_knowledge_snapshots, wtm_inci_dictionary_aliases, wtm_inci_dictionary_entries, wtm_inci_dictionary_snapshots, wtm_inci_ingredients CASCADE',
      );
      await database.inciDictionary.publish(dictionary);
      const draft = prepareIngredientKnowledgePublication(
        raw,
        dictionary.snapshot,
        publishedAt,
      );
      const input = {
        draft,
        dictionaryVersion: dictionary.snapshot.dictionaryVersion,
        publishedAt,
        dryRun: true,
      };
      assert.equal(
        (await database.ingredientKnowledge.publishInitialSnapshot(input)).kind,
        'READY',
      );
      assert.equal(
        await database.ingredientKnowledge.findPublishedSnapshot(),
        null,
      );
      const attempts = await Promise.all(
        [1, 2].map(() =>
          database.ingredientKnowledge.publishInitialSnapshot({
            ...input,
            dryRun: false,
          }),
        ),
      );
      assert.deepEqual(attempts.map((result) => result.kind).sort(), [
        'ALREADY_PUBLISHED',
        'PUBLISHED',
      ]);
      const snapshot =
        await database.ingredientKnowledge.findPublishedSnapshot();
      assert.equal(snapshot?.version, draft.version);
      assert.equal(snapshot?.facts.length, 2);
      assert.equal(snapshot?.facts[0]?.evidence[0]?.stance, 'SUPPORTS');
      assert.equal(
        (await database.ingredientKnowledge.publishInitialSnapshot(input)).kind,
        'ALREADY_PUBLISHED',
      );
      const changed = prepareIngredientKnowledgePublication(
        raw.replaceAll('"HIGH"', '"LOW"'),
        dictionary.snapshot,
        publishedAt,
      );
      assert.equal(
        (
          await database.ingredientKnowledge.publishInitialSnapshot({
            ...input,
            draft: changed,
            dryRun: false,
          })
        ).kind,
        'VERSION_CONFLICT',
      );
      const successor = prepareIngredientKnowledgePublication(
        raw.replace(
          'fda-colorants-2026.09.20-v1',
          'fda-colorants-2026.09.20-v2',
        ),
        dictionary.snapshot,
        publishedAt,
      );
      assert.equal(
        (
          await database.ingredientKnowledge.publishInitialSnapshot({
            ...input,
            draft: successor,
            dryRun: false,
          })
        ).kind,
        'ACTIVE_SNAPSHOT_CONFLICT',
      );
      assert.deepEqual(
        await database.ingredientKnowledge.findPublishedSnapshot(),
        snapshot,
      );
      await assert.rejects(
        admin.query(
          "UPDATE wtm_ingredient_function_facts SET function_code = 'INVENTED' WHERE snapshot_id = $1",
          [draft.snapshotId],
        ),
        /immutable/,
      );
    } finally {
      await database.close();
      await admin.end();
    }
  },
);
