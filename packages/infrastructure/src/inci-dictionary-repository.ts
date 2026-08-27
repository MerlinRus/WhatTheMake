import type { Pool } from 'pg';

import {
  INCI_LOOKUP_NORMALIZER_VERSION,
  type CanonicalIngredientId,
  type InciDictionaryAliasId,
  type InciDictionaryIngredient,
  type InciDictionaryRepository,
  type InciDictionarySnapshot,
  type InciDictionaryVersion,
} from '@wtm/domain';

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
  };
}
