import type { Pool, PoolClient } from 'pg';

import {
  AccountEmailConflictError,
  type AccountCredential,
  type AccountIdentity,
  type AuthenticatedIdentity,
  type CreateAccountInput,
  type GuestIdentity,
  type IdentityRepository,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

interface GuestRow {
  guest_id: string;
  created_at: Date;
}

interface AccountIdentityRow {
  account_id: string;
  email_normalized: string;
  created_at: Date;
}

interface AccountRow extends AccountIdentityRow {
  password_hash: string;
  status: 'ACTIVE' | 'BLOCKED' | 'DELETED';
}

interface SessionRow {
  subject_kind: 'GUEST' | 'ACCOUNT';
  guest_id: string | null;
  account_id: string | null;
  email_normalized: string | null;
  created_at: Date;
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    'constraint' in error &&
    (error as { code?: unknown }).code === '23505' &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

function guestIdentity(row: GuestRow): GuestIdentity {
  return {
    kind: 'GUEST',
    guestId: row.guest_id,
    createdAt: row.created_at,
  };
}

function accountIdentity(row: AccountIdentityRow): AccountIdentity {
  return {
    kind: 'ACCOUNT',
    accountId: row.account_id,
    email: row.email_normalized,
    createdAt: row.created_at,
  };
}

async function claimGuestSession(
  client: PoolClient,
  guestSessionTokenHash: string | undefined,
  accountId: string,
): Promise<void> {
  if (!guestSessionTokenHash) return;

  const guestSession = await client.query<{ guest_id: string }>(
    `
      SELECT session.guest_id
      FROM wtm_identity_sessions AS session
      JOIN wtm_guests AS guest ON guest.id = session.guest_id
      WHERE session.token_hash = $1
        AND session.subject_kind = 'GUEST'
        AND session.revoked_at IS NULL
        AND guest.deleted_at IS NULL
        AND guest.claimed_by_account_id IS NULL
      FOR UPDATE OF guest
    `,
    [guestSessionTokenHash],
  );
  const guestId = guestSession.rows[0]?.guest_id;
  if (!guestId) return;

  await client.query(
    `
      UPDATE wtm_guests
      SET claimed_by_account_id = $1
      WHERE id = $2
    `,
    [accountId, guestId],
  );
  await client.query(
    `
      UPDATE wtm_identity_sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE guest_id = $1
    `,
    [guestId],
  );
}

export function createPostgresIdentityRepository(
  pool: Pool,
): IdentityRepository {
  return {
    async createGuestSession(sessionTokenHash): Promise<GuestIdentity> {
      return withTransaction(pool, async (client) => {
        const guest = await client.query<GuestRow>(`
          INSERT INTO wtm_guests DEFAULT VALUES
          RETURNING id AS guest_id, created_at
        `);
        const row = guest.rows[0];
        if (!row) throw new Error('Guest insert returned no row');

        await client.query(
          `
            INSERT INTO wtm_identity_sessions (
              token_hash,
              subject_kind,
              guest_id
            )
            VALUES ($1, 'GUEST', $2)
          `,
          [sessionTokenHash, row.guest_id],
        );
        return guestIdentity(row);
      });
    },

    async resolveSession(
      sessionTokenHash,
    ): Promise<AuthenticatedIdentity | null> {
      const session = await pool.query<SessionRow>(
        `
          SELECT
            session.subject_kind,
            session.guest_id,
            session.account_id,
            account.email_normalized,
            CASE
              WHEN session.subject_kind = 'GUEST' THEN guest.created_at
              ELSE account.created_at
            END AS created_at
          FROM wtm_identity_sessions AS session
          LEFT JOIN wtm_guests AS guest ON guest.id = session.guest_id
          LEFT JOIN wtm_accounts AS account ON account.id = session.account_id
          WHERE session.token_hash = $1
            AND session.revoked_at IS NULL
            AND (
              (
                session.subject_kind = 'GUEST'
                AND guest.deleted_at IS NULL
                AND guest.claimed_by_account_id IS NULL
              )
              OR
              (
                session.subject_kind = 'ACCOUNT'
                AND account.status = 'ACTIVE'
                AND session.expires_at > now()
              )
            )
        `,
        [sessionTokenHash],
      );
      const row = session.rows[0];
      if (!row) return null;

      if (row.subject_kind === 'GUEST' && row.guest_id) {
        return guestIdentity({
          guest_id: row.guest_id,
          created_at: row.created_at,
        });
      }
      if (row.account_id && row.email_normalized) {
        return accountIdentity({
          account_id: row.account_id,
          email_normalized: row.email_normalized,
          created_at: row.created_at,
        });
      }
      return null;
    },

    async deleteGuestBySession(sessionTokenHash): Promise<void> {
      await withTransaction(pool, async (client) => {
        const session = await client.query<{ guest_id: string }>(
          `
            SELECT session.guest_id
            FROM wtm_identity_sessions AS session
            JOIN wtm_guests AS guest ON guest.id = session.guest_id
            WHERE session.token_hash = $1
              AND session.subject_kind = 'GUEST'
              AND session.revoked_at IS NULL
              AND guest.deleted_at IS NULL
            FOR UPDATE OF guest
          `,
          [sessionTokenHash],
        );
        const guestId = session.rows[0]?.guest_id;
        if (!guestId) return;

        await client.query(
          'UPDATE wtm_guests SET deleted_at = now() WHERE id = $1',
          [guestId],
        );
        await client.query(
          `
            UPDATE wtm_identity_sessions
            SET revoked_at = COALESCE(revoked_at, now())
            WHERE guest_id = $1
          `,
          [guestId],
        );
      });
    },

    async createAccount(input: CreateAccountInput): Promise<AccountIdentity> {
      try {
        return await withTransaction(pool, async (client) => {
          const account = await client.query<AccountRow>(
            `
              INSERT INTO wtm_accounts (email_normalized, password_hash)
              VALUES ($1, $2)
              RETURNING
                id AS account_id,
                email_normalized,
                password_hash,
                status,
                created_at
            `,
            [input.email, input.passwordHash],
          );
          const row = account.rows[0];
          if (!row) throw new Error('Account insert returned no row');

          await claimGuestSession(
            client,
            input.guestSessionTokenHash,
            row.account_id,
          );

          await client.query(
            `
              INSERT INTO wtm_identity_sessions (
                token_hash,
                subject_kind,
                account_id,
                expires_at
              )
              VALUES ($1, 'ACCOUNT', $2, $3)
            `,
            [input.sessionTokenHash, row.account_id, input.expiresAt],
          );
          return accountIdentity(row);
        });
      } catch (error) {
        if (
          isConstraintViolation(error, 'wtm_accounts_email_normalized_unique')
        ) {
          throw new AccountEmailConflictError();
        }
        throw error;
      }
    },

    async findAccountByEmail(email): Promise<AccountCredential | null> {
      const account = await pool.query<AccountRow>(
        `
          SELECT
            id AS account_id,
            email_normalized,
            password_hash,
            status,
            created_at
          FROM wtm_accounts
          WHERE email_normalized = $1
        `,
        [email],
      );
      const row = account.rows[0];
      if (!row) return null;
      return {
        ...accountIdentity(row),
        passwordHash: row.password_hash,
        status: row.status,
      };
    },

    async createAccountSession(
      accountId,
      sessionTokenHash,
      expiresAt,
      guestSessionTokenHash,
    ): Promise<AccountIdentity | null> {
      return withTransaction(pool, async (client) => {
        const account = await client.query<AccountRow>(
          `
            SELECT
              id AS account_id,
              email_normalized,
              password_hash,
              status,
              created_at
            FROM wtm_accounts
            WHERE id = $1 AND status = 'ACTIVE'
            FOR UPDATE
          `,
          [accountId],
        );
        const row = account.rows[0];
        if (!row) return null;

        await claimGuestSession(client, guestSessionTokenHash, accountId);

        await client.query(
          `
            INSERT INTO wtm_identity_sessions (
              token_hash,
              subject_kind,
              account_id,
              expires_at
            )
            VALUES ($1, 'ACCOUNT', $2, $3)
          `,
          [sessionTokenHash, accountId, expiresAt],
        );
        return accountIdentity(row);
      });
    },

    async revokeSession(sessionTokenHash): Promise<void> {
      await pool.query(
        `
          UPDATE wtm_identity_sessions
          SET revoked_at = COALESCE(revoked_at, now())
          WHERE token_hash = $1
        `,
        [sessionTokenHash],
      );
    },
  };
}
