import type { Pool } from 'pg';
import type { AccountSecurityRepository } from '@wtm/domain';

import { withTransaction } from './transaction.js';

export function createPostgresAccountSecurityRepository(
  pool: Pool,
): AccountSecurityRepository {
  return {
    async rotateRecoveryCode(input) {
      return withTransaction(pool, async (client) => {
        const account = await client.query(
          `SELECT id FROM wtm_accounts
           WHERE id = $1 AND status = 'ACTIVE' AND password_hash = $2
           FOR UPDATE`,
          [input.accountId, input.expectedPasswordHash],
        );
        if (account.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO wtm_account_recovery_codes (account_id, code_hash) VALUES ($1, $2)
           ON CONFLICT (account_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, created_at = now()`,
          [input.accountId, input.codeHash],
        );
        return true;
      });
    },
    async recoverAccount(input) {
      return withTransaction(pool, async (client) => {
        const account = await client.query<{ id: string }>(
          `SELECT id FROM wtm_accounts
           WHERE email_normalized = $1 AND status = 'ACTIVE' FOR UPDATE`,
          [input.emailNormalized],
        );
        const accountId = account.rows[0]?.id;
        if (!accountId) return false;
        const consumed = await client.query(
          'DELETE FROM wtm_account_recovery_codes WHERE account_id = $1 AND code_hash = $2 RETURNING account_id',
          [accountId, input.codeHash],
        );
        if (consumed.rowCount !== 1) return false;
        await client.query(
          'UPDATE wtm_accounts SET password_hash = $2, updated_at = now() WHERE id = $1',
          [accountId, input.newPasswordHash],
        );
        await client.query(
          'UPDATE wtm_identity_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL',
          [accountId],
        );
        return true;
      });
    },
  };
}
