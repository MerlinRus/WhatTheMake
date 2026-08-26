import type { Pool } from 'pg';

import type {
  MascaraBriefSnapshot,
  MascaraGoal,
  PreferencesRepository,
  RemovalPreference,
  SavedMascaraPreference,
  WaterproofPreference,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

interface PreferenceRow {
  profile_version: number;
  schema_version: 1;
  mode: 'PERSONALIZED' | 'UNKNOWN_GOALS';
  goals: MascaraGoal[];
  waterproof_preference: WaterproofPreference;
  removal_preference: RemovalPreference;
  sensitive_eyes: boolean;
  contact_lenses: boolean;
  avoided_ingredients: string[];
  created_at: Date;
}

function savedPreference(row: PreferenceRow): SavedMascaraPreference {
  const shared = {
    schemaVersion: row.schema_version,
    waterproof: row.waterproof_preference,
    removal: row.removal_preference,
    sensitiveEyes: row.sensitive_eyes,
    contactLenses: row.contact_lenses,
    avoidedIngredients: row.avoided_ingredients,
  };
  const snapshot: MascaraBriefSnapshot =
    row.mode === 'PERSONALIZED'
      ? { ...shared, mode: 'PERSONALIZED', goals: row.goals }
      : { ...shared, mode: 'UNKNOWN_GOALS', goals: [] };

  return {
    snapshot,
    profileVersion: row.profile_version,
    createdAt: row.created_at,
  };
}

const selectColumns = `
  profile_version,
  schema_version,
  mode,
  goals,
  waterproof_preference,
  removal_preference,
  sensitive_eyes,
  contact_lenses,
  avoided_ingredients,
  created_at
`;

export function createPostgresPreferencesRepository(
  pool: Pool,
): PreferencesRepository {
  return {
    async currentMascaraPreference(
      accountId,
    ): Promise<SavedMascaraPreference | null> {
      const preference = await pool.query<PreferenceRow>(
        `
          SELECT ${selectColumns}
          FROM wtm_mascara_preference_versions
          WHERE account_id = $1
          ORDER BY profile_version DESC
          LIMIT 1
        `,
        [accountId],
      );
      const row = preference.rows[0];
      return row ? savedPreference(row) : null;
    },

    async saveMascaraPreference(
      accountId,
      snapshot,
    ): Promise<SavedMascaraPreference | null> {
      return withTransaction(pool, async (client) => {
        const activeAccount = await client.query(
          `
            SELECT id
            FROM wtm_accounts
            WHERE id = $1 AND status = 'ACTIVE'
            FOR UPDATE
          `,
          [accountId],
        );
        if (activeAccount.rowCount !== 1) return null;

        const preference = await client.query<PreferenceRow>(
          `
            INSERT INTO wtm_mascara_preference_versions (
              account_id,
              profile_version,
              schema_version,
              mode,
              goals,
              waterproof_preference,
              removal_preference,
              sensitive_eyes,
              contact_lenses,
              avoided_ingredients
            )
            SELECT
              $1,
              COALESCE(MAX(profile_version), 0) + 1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9
            FROM wtm_mascara_preference_versions
            WHERE account_id = $1
            RETURNING ${selectColumns}
          `,
          [
            accountId,
            snapshot.schemaVersion,
            snapshot.mode,
            snapshot.goals,
            snapshot.waterproof,
            snapshot.removal,
            snapshot.sensitiveEyes,
            snapshot.contactLenses,
            snapshot.avoidedIngredients,
          ],
        );
        const row = preference.rows[0];
        if (!row) throw new Error('Mascara preference insert returned no row');
        return savedPreference(row);
      });
    },
  };
}
