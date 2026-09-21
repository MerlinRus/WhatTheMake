import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AccountErasureRepository } from '@wtm/domain';
import { withTransaction } from './transaction.js';

export function createPostgresAccountErasureRepository(
  pool: Pool,
): AccountErasureRepository {
  return {
    async erase(input) {
      return withTransaction(pool, async (client) => {
        const account = await client.query<{
          password_hash: string;
          status: string;
        }>(
          'SELECT password_hash, status FROM wtm_accounts WHERE id = $1 FOR UPDATE',
          [input.accountId],
        );
        const current = account.rows[0];
        if (
          !current ||
          current.status !== 'ACTIVE' ||
          current.password_hash !== input.expectedPasswordHash
        )
          return 'AUTH_CHANGED';
        const session = await client.query(
          "SELECT id FROM wtm_identity_sessions WHERE account_id = $1 AND token_hash = $2 AND subject_kind = 'ACCOUNT' AND revoked_at IS NULL AND expires_at > now() FOR UPDATE",
          [input.accountId, input.sessionTokenHash],
        );
        if (session.rowCount !== 1) return 'AUTH_CHANGED';
        // Account lock serializes login/claim, review writes and recovery/reset.
        await client.query(
          'SELECT id FROM wtm_guests WHERE claimed_by_account_id = $1 ORDER BY id FOR UPDATE',
          [input.accountId],
        );
        // OCR revisions reference media assets, so cascade their observations first.
        await client.query(
          'DELETE FROM wtm_product_observations WHERE account_id = $1 OR guest_id IN (SELECT id FROM wtm_guests WHERE claimed_by_account_id = $1)',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_media_collections WHERE account_id = $1 OR guest_id IN (SELECT id FROM wtm_guests WHERE claimed_by_account_id = $1)',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_product_observation_confirmations WHERE account_id = $1',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_guests WHERE claimed_by_account_id = $1',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_mascara_preference_versions WHERE account_id = $1',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_customer_reviews WHERE account_id = $1',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_account_recovery_codes WHERE account_id = $1',
          [input.accountId],
        );
        await client.query(
          'DELETE FROM wtm_identity_sessions WHERE account_id = $1',
          [input.accountId],
        );
        // Keep only a pseudonymous account row for published moderation audit FKs.
        await client.query(
          "UPDATE wtm_accounts SET status = 'DELETED', email_normalized = $2, password_hash = 'deleted', updated_at = now() WHERE id = $1",
          [
            input.accountId,
            `${input.accountId}.${randomUUID()}@deleted.invalid`,
          ],
        );
        return 'ERASED';
      });
    },
  };
}
