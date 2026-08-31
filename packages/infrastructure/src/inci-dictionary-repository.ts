import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  INCI_LOOKUP_NORMALIZER_VERSION,
  serializeInciDictionarySnapshot,
  type CanonicalIngredientId,
  type InciDictionaryAliasId,
  type InciDictionaryIngredient,
  type InciDictionaryPublicationCounts,
  type InciDictionaryPublicationInput,
  type InciDictionaryPublicationReport,
  type InciDictionaryRepository,
  type InciDictionarySnapshot,
  type InciDictionaryVersion,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

const PUBLICATION_LOCK_KEY = 928_042_026;

interface DictionaryRow {
  dictionary_version: string;
  normalizer_version: string;
  ingredient_id: string | null;
  canonical_name: string | null;
  canonical_lookup_key: string | null;
  alias_id: string | null;
  alias_text: string | null;
  alias_lookup_key: string | null;
}

interface MutableDictionaryIngredient extends InciDictionaryIngredient {
  aliases: Array<{
    aliasId: InciDictionaryAliasId;
    aliasText: string;
    lookupKey: string;
  }>;
}

interface DictionaryIdentityRow {
  dictionary_version: string;
  content_sha256: string | null;
  status: string;
}

function publicationCounts(
  input: InciDictionaryPublicationInput,
): InciDictionaryPublicationCounts {
  return {
    ingredients: input.snapshot.ingredients.length,
    aliases: input.snapshot.ingredients.reduce(
      (count, ingredient) => count + ingredient.aliases.length,
      0,
    ),
  };
}

function requireContentBoundChecksum(
  input: InciDictionaryPublicationInput,
): void {
  const expected = createHash('sha256')
    .update(serializeInciDictionarySnapshot(input.snapshot), 'utf8')
    .digest('hex');
  if (input.contentSha256 !== expected) {
    throw new Error('INCI dictionary content checksum does not match snapshot');
  }
}

async function publicationState(
  queryable: Pick<Pool | PoolClient, 'query'>,
  input: InciDictionaryPublicationInput,
): Promise<InciDictionaryPublicationReport> {
  const existing = await queryable.query<DictionaryIdentityRow>(
    `
      SELECT
        version AS dictionary_version,
        content_sha256,
        status
      FROM wtm_inci_dictionary_snapshots
      WHERE
        status = 'PUBLISHED'
        OR version = $1
        OR content_sha256 = $2
      ORDER BY (status = 'PUBLISHED') DESC, created_at, id
      LIMIT 1
    `,
    [input.snapshot.dictionaryVersion, input.contentSha256],
  );
  const row = existing.rows[0];
  const base = {
    dictionaryVersion: input.snapshot.dictionaryVersion,
    contentSha256: input.contentSha256,
    counts: publicationCounts(input),
  };
  if (!row) return { kind: 'READY', ...base };
  if (
    row.status === 'PUBLISHED' &&
    row.dictionary_version === input.snapshot.dictionaryVersion &&
    row.content_sha256 === input.contentSha256
  ) {
    return { kind: 'ALREADY_PUBLISHED', ...base };
  }
  return {
    kind: 'VERSION_CONFLICT',
    ...base,
    existingVersion: row.dictionary_version as InciDictionaryVersion,
    existingContentSha256: row.content_sha256,
  };
}

async function insertSnapshot(
  client: PoolClient,
  input: InciDictionaryPublicationInput,
): Promise<void> {
  const snapshot = await client.query<{ id: string }>(
    `
      INSERT INTO wtm_inci_dictionary_snapshots (
        version,
        normalizer_version,
        content_sha256
      )
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [
      input.snapshot.dictionaryVersion,
      input.snapshot.normalizerVersion,
      input.contentSha256,
    ],
  );
  const snapshotId = snapshot.rows[0]?.id;
  if (!snapshotId) throw new Error('INCI dictionary snapshot insert failed');

  for (const ingredient of input.snapshot.ingredients) {
    await client.query(
      `
        INSERT INTO wtm_inci_ingredients (id)
        VALUES ($1)
        ON CONFLICT (id) DO NOTHING
      `,
      [ingredient.ingredientId],
    );
    await client.query(
      `
        INSERT INTO wtm_inci_dictionary_entries (
          snapshot_id,
          ingredient_id,
          canonical_name,
          canonical_lookup_key
        )
        VALUES ($1, $2, $3, $4)
      `,
      [
        snapshotId,
        ingredient.ingredientId,
        ingredient.canonicalName,
        ingredient.canonicalLookupKey,
      ],
    );
    for (const alias of ingredient.aliases) {
      await client.query(
        `
          INSERT INTO wtm_inci_dictionary_aliases (
            id,
            snapshot_id,
            ingredient_id,
            alias_text,
            lookup_key
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          alias.aliasId,
          snapshotId,
          ingredient.ingredientId,
          alias.aliasText,
          alias.lookupKey,
        ],
      );
    }
  }

  await client.query(
    `
      UPDATE wtm_inci_dictionary_snapshots
      SET status = 'PUBLISHED', published_at = now()
      WHERE id = $1
    `,
    [snapshotId],
  );
}

function requireIngredientFields(row: DictionaryRow): {
  ingredientId: CanonicalIngredientId;
  canonicalName: string;
  canonicalLookupKey: string;
} | null {
  if (row.ingredient_id === null) return null;
  if (row.canonical_name === null || row.canonical_lookup_key === null) {
    throw new Error('INCI dictionary entry row is incomplete');
  }
  return {
    ingredientId: row.ingredient_id as CanonicalIngredientId,
    canonicalName: row.canonical_name,
    canonicalLookupKey: row.canonical_lookup_key,
  };
}

export function createPostgresInciDictionaryRepository(
  pool: Pool,
): InciDictionaryRepository {
  return {
    async findPublishedSnapshot(): Promise<InciDictionarySnapshot | null> {
      const result = await pool.query<DictionaryRow>(`
        SELECT
          snapshot.version AS dictionary_version,
          snapshot.normalizer_version,
          entry.ingredient_id,
          entry.canonical_name,
          entry.canonical_lookup_key,
          alias.id AS alias_id,
          alias.alias_text,
          alias.lookup_key AS alias_lookup_key
        FROM wtm_inci_dictionary_snapshots AS snapshot
        LEFT JOIN wtm_inci_dictionary_entries AS entry
          ON entry.snapshot_id = snapshot.id
        LEFT JOIN wtm_inci_dictionary_aliases AS alias
          ON alias.snapshot_id = entry.snapshot_id
          AND alias.ingredient_id = entry.ingredient_id
        WHERE snapshot.status = 'PUBLISHED'
        ORDER BY
          entry.canonical_lookup_key NULLS FIRST,
          entry.ingredient_id,
          alias.lookup_key,
          alias.id
      `);
      const first = result.rows[0];
      if (!first) return null;
      if (first.normalizer_version !== INCI_LOOKUP_NORMALIZER_VERSION) {
        throw new Error(
          `Unsupported INCI normalizer version: ${first.normalizer_version}`,
        );
      }

      const ingredients = new Map<string, MutableDictionaryIngredient>();
      for (const row of result.rows) {
        const fields = requireIngredientFields(row);
        if (!fields) continue;
        let ingredient = ingredients.get(fields.ingredientId);
        if (!ingredient) {
          ingredient = { ...fields, aliases: [] };
          ingredients.set(fields.ingredientId, ingredient);
        }

        if (row.alias_id !== null) {
          if (row.alias_text === null || row.alias_lookup_key === null) {
            throw new Error('INCI dictionary alias row is incomplete');
          }
          ingredient.aliases.push({
            aliasId: row.alias_id as InciDictionaryAliasId,
            aliasText: row.alias_text,
            lookupKey: row.alias_lookup_key,
          });
        }
      }

      return {
        dictionaryVersion: first.dictionary_version as InciDictionaryVersion,
        normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
        ingredients: [...ingredients.values()],
      };
    },

    async previewPublication(input) {
      requireContentBoundChecksum(input);
      return publicationState(pool, input);
    },

    async publish(input) {
      requireContentBoundChecksum(input);
      return withTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [
          PUBLICATION_LOCK_KEY,
        ]);
        const state = await publicationState(client, input);
        if (state.kind !== 'READY') return state;
        await insertSnapshot(client, input);
        return { ...state, kind: 'PUBLISHED' };
      });
    },
  };
}
