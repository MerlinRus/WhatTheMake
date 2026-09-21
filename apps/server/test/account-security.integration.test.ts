import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';

import { createPostgresDatabase } from '../../../packages/infrastructure/src/postgres.js';
import { createPostgresAccountSecurityRepository } from '../../../packages/infrastructure/src/account-security-repository.js';
import { createAccountSecurityService } from '../src/account-security/service.js';
import { AppError } from '../src/errors.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import {
  createIdentityService,
  hashSessionToken,
} from '../src/identity/service.js';

const connectionString = process.env.TEST_DATABASE_URL;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const passwords = createPasswordHasher({
  cost: 1024,
  blockSize: 8,
  parallelization: 1,
});
const originalPassword = 'Original password 123';
const nextPassword = 'Replacement password 456';

test(
  'offline recovery rotates, consumes once under concurrency, changes password and revokes all sessions',
  { skip: connectionString === undefined },
  async () => {
    assert.ok(connectionString);
    const database = createPostgresDatabase({
      connectionString,
      maxConnections: 3,
      applicationName: 'wtm-recovery-test',
    });
    const pool = new Pool({ connectionString, max: 3 });
    const repository = createPostgresAccountSecurityRepository(pool);
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const rawToken = randomBytes(32).toString('base64url');
      const credentialHash = await passwords.hash(originalPassword);
      const account = await database.identity.createAccount({
        email: `recovery-${randomUUID()}@example.test`,
        passwordHash: credentialHash,
        sessionTokenHash: hashSessionToken(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const secondToken = randomBytes(32).toString('base64url');
      await database.identity.createAccountSession(
        account.accountId,
        hashSessionToken(secondToken),
        new Date(Date.now() + 60_000),
      );
      const service = createAccountSecurityService({
        identity: createIdentityService({
          repository: database.identity,
          passwordHasher: passwords,
        }),
        identities: database.identity,
        repository,
        passwordHasher: passwords,
      });
      await assert.rejects(
        () => service.rotateRecoveryCode(rawToken, 'Wrong password 123'),
        (error: unknown) =>
          error instanceof AppError && error.statusCode === 401,
      );
      const first = await service.rotateRecoveryCode(
        rawToken,
        originalPassword,
      );
      assert.match(first.recoveryCode, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(first.recoveryCode, 'base64url').length, 32);
      const stored = await pool.query<{ code_hash: string }>(
        'SELECT code_hash FROM wtm_account_recovery_codes WHERE account_id = $1',
        [account.accountId],
      );
      assert.equal(stored.rows[0]?.code_hash, hash(first.recoveryCode));
      assert.notEqual(stored.rows[0]?.code_hash, first.recoveryCode);
      const rotated = await service.rotateRecoveryCode(
        rawToken,
        originalPassword,
      );
      assert.notEqual(rotated.recoveryCode, first.recoveryCode);
      for (const [email, code] of [
        [account.email, first.recoveryCode],
        ['missing@example.test', rotated.recoveryCode],
        [account.email, 'invalid'],
        ['invalid', rotated.recoveryCode],
      ]) {
        await assert.rejects(
          () =>
            service.recoverAccount({
              email: email!,
              code: code!,
              newPassword: nextPassword,
            }),
          (error: unknown) =>
            error instanceof AppError &&
            error.statusCode === 401 &&
            error.message === 'Invalid recovery credentials',
        );
      }
      const resetInput = {
        email: ` ${account.email.toUpperCase()} `,
        code: rotated.recoveryCode,
        newPassword: nextPassword,
      };
      const concurrent = await Promise.allSettled([
        service.recoverAccount(resetInput),
        service.recoverAccount(resetInput),
      ]);
      assert.equal(
        concurrent.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = concurrent.find(
        (result) => result.status === 'rejected',
      );
      assert.ok(
        rejected?.status === 'rejected' &&
          rejected.reason instanceof AppError &&
          rejected.reason.statusCode === 401,
      );
      const updated = await database.identity.findAccountByEmail(account.email);
      assert.ok(updated);
      assert.equal(
        await passwords.verify(nextPassword, updated.passwordHash),
        true,
      );
      assert.equal(
        await passwords.verify(originalPassword, updated.passwordHash),
        false,
      );
      assert.equal(
        await database.identity.resolveSession(hashSessionToken(rawToken)),
        null,
      );
      assert.equal(
        await database.identity.resolveSession(hashSessionToken(secondToken)),
        null,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT account_id FROM wtm_account_recovery_codes WHERE account_id = $1',
            [account.accountId],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        () => service.recoverAccount(resetInput),
        (error: unknown) =>
          error instanceof AppError && error.statusCode === 401,
      );
    } finally {
      await Promise.all([database.close(), pool.end()]);
    }
  },
);

test(
  'recovery repository rejects blocked accounts and password-reauthentication races',
  { skip: connectionString === undefined },
  async () => {
    assert.ok(connectionString);
    const database = createPostgresDatabase({
      connectionString,
      maxConnections: 2,
      applicationName: 'wtm-recovery-race-test',
    });
    const pool = new Pool({ connectionString, max: 2 });
    const repository = createPostgresAccountSecurityRepository(pool);
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const oldHash = await passwords.hash(originalPassword);
      const newHash = await passwords.hash(nextPassword);
      const account = await database.identity.createAccount({
        email: `recovery-race-${randomUUID()}@example.test`,
        passwordHash: oldHash,
        sessionTokenHash: hash(randomUUID()),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const firstHash = hash(randomUUID());
      assert.equal(
        await repository.rotateRecoveryCode({
          accountId: account.accountId,
          expectedPasswordHash: oldHash,
          codeHash: firstHash,
        }),
        true,
      );
      await pool.query(
        'UPDATE wtm_accounts SET password_hash = $2 WHERE id = $1',
        [account.accountId, newHash],
      );
      assert.equal(
        await database.identity.createAccountSession(
          account.accountId,
          hash(randomUUID()),
          new Date(Date.now() + 60_000),
          undefined,
          oldHash,
        ),
        null,
        'A login verified before password reset must not mint a new session',
      );
      assert.equal(
        await repository.rotateRecoveryCode({
          accountId: account.accountId,
          expectedPasswordHash: oldHash,
          codeHash: hash(randomUUID()),
        }),
        false,
      );
      assert.equal(
        (
          await pool.query<{ code_hash: string }>(
            'SELECT code_hash FROM wtm_account_recovery_codes WHERE account_id = $1',
            [account.accountId],
          )
        ).rows[0]?.code_hash,
        firstHash,
      );
      await pool.query(
        "UPDATE wtm_accounts SET status = 'BLOCKED' WHERE id = $1",
        [account.accountId],
      );
      assert.equal(
        await repository.rotateRecoveryCode({
          accountId: account.accountId,
          expectedPasswordHash: newHash,
          codeHash: hash(randomUUID()),
        }),
        false,
      );
      assert.equal(
        await repository.recoverAccount({
          emailNormalized: account.email,
          codeHash: firstHash,
          newPasswordHash: oldHash,
        }),
        false,
      );
      assert.equal(
        (await database.identity.findAccountByEmail(account.email))
          ?.passwordHash,
        newHash,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT account_id FROM wtm_account_recovery_codes WHERE account_id = $1',
            [account.accountId],
          )
        ).rowCount,
        1,
      );
    } finally {
      await Promise.all([database.close(), pool.end()]);
    }
  },
);
