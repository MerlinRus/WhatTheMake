import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  AccountCredential,
  AccountSecurityRepository,
  AuthenticatedIdentity,
  RecoverAccountInput,
  RotateAccountRecoveryCodeInput,
} from '@wtm/domain';
import { buildApp } from '../src/app.js';
import { createAccountSecurityService } from '../src/account-security/service.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { registerAccountSecurityRoutes } from '../src/routes/account-security.js';

const token = 'a'.repeat(43);
const password = 'Original password 123';
const passwords = createPasswordHasher({
  cost: 1024,
  blockSize: 8,
  parallelization: 1,
});

async function fixture() {
  const credential: AccountCredential = {
    kind: 'ACCOUNT',
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'buyer@example.test',
    createdAt: new Date(),
    status: 'ACTIVE',
    passwordHash: await passwords.hash(password),
  };
  let principal: AuthenticatedIdentity = credential;
  let recoveryHash: string | null = null;
  const rotations: RotateAccountRecoveryCodeInput[] = [];
  const recoveries: RecoverAccountInput[] = [];
  const repository: AccountSecurityRepository = {
    async rotateRecoveryCode(input) {
      rotations.push(input);
      recoveryHash = input.codeHash;
      return true;
    },
    async recoverAccount(input) {
      recoveries.push(input);
      if (
        input.emailNormalized !== credential.email ||
        input.codeHash !== recoveryHash
      )
        return false;
      recoveryHash = null;
      return true;
    },
  };
  const service = createAccountSecurityService({
    identity: {
      async current(value) {
        return value === token ? principal : null;
      },
    },
    identities: {
      async findAccountByEmail(email) {
        return email === credential.email ? credential : null;
      },
    },
    repository,
    passwordHasher: passwords,
  });
  const app = await buildApp();
  await registerAccountSecurityRoutes(app, {
    service,
    publicOrigin: 'https://whatthemake.test',
    cookieName: 'wtm_session',
  });
  return {
    app,
    service,
    rotations,
    recoveries,
    credential,
    guest() {
      principal = {
        kind: 'GUEST',
        guestId: credential.accountId,
        createdAt: new Date(),
      };
    },
  };
}

test('recovery routes expose a code only on password-reauthenticated rotation and never auto-login', async () => {
  const f = await fixture();
  const headers = {
    origin: 'https://whatthemake.test',
    cookie: `wtm_session=${token}`,
  };
  try {
    const issued = await f.app.inject({
      method: 'POST',
      url: '/api/v1/accounts/current/recovery-code',
      headers,
      payload: { currentPassword: password },
    });
    assert.equal(issued.statusCode, 200, issued.body);
    assert.equal(issued.headers['cache-control'], 'private, no-store');
    assert.equal(issued.headers['set-cookie'], undefined);
    const code = issued.json<{ recoveryCode: string }>().recoveryCode;
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      f.rotations[0]?.expectedPasswordHash,
      f.credential.passwordHash,
    );
    assert.equal(
      f.rotations[0]?.codeHash,
      createHash('sha256').update(code).digest('hex'),
    );
    const reset = await f.app.inject({
      method: 'POST',
      url: '/api/v1/account-recovery',
      headers: { origin: headers.origin },
      payload: {
        email: ' BUYER@EXAMPLE.TEST ',
        code,
        newPassword: 'New password 4567',
      },
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.deepEqual(reset.json(), { reset: true, requiresLogin: true });
    assert.equal(reset.headers['set-cookie'], undefined);
    assert.equal(reset.headers['cache-control'], 'private, no-store');
    assert.equal(reset.body.includes(code), false);
    assert.equal(
      await passwords.verify(
        'New password 4567',
        f.recoveries[0]!.newPasswordHash,
      ),
      true,
    );
    assert.equal(
      f.recoveries[0]!.newPasswordHash.includes('New password'),
      false,
    );
  } finally {
    await f.app.close();
  }
});

test('recovery uses identical credential errors and enforces password boundaries, JSON, origin and account scope', async () => {
  const f = await fixture();
  const origin = 'https://whatthemake.test';
  try {
    for (const [email, code] of [
      ['missing@example.test', 'b'.repeat(43)],
      ['buyer@example.test', 'b'.repeat(43)],
      ['not-an-email', 'bad-code'],
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/v1/account-recovery',
        headers: { origin },
        payload: { email, code, newPassword: 'New password 4567' },
      });
      assert.equal(response.statusCode, 401, response.body);
      const error = response.json().error;
      assert.equal(error.code, 'UNAUTHENTICATED');
      assert.equal(error.message, 'Invalid recovery credentials');
      assert.equal(error.details, undefined);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.body.includes(code!), false);
    }
    for (const newPassword of ['short', 'x'.repeat(129)]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/v1/account-recovery',
        headers: { origin },
        payload: {
          email: 'buyer@example.test',
          code: 'b'.repeat(43),
          newPassword,
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    const unauthenticated = await f.app.inject({
      method: 'POST',
      url: '/api/v1/accounts/current/recovery-code',
      headers: { origin },
      payload: { currentPassword: password },
    });
    assert.equal(unauthenticated.statusCode, 401);
    f.guest();
    const guest = await f.app.inject({
      method: 'POST',
      url: '/api/v1/accounts/current/recovery-code',
      headers: { origin, cookie: `wtm_session=${token}` },
      payload: { currentPassword: password },
    });
    assert.equal(guest.statusCode, 403);
    const foreign = await f.app.inject({
      method: 'POST',
      url: '/api/v1/accounts/current/recovery-code',
      headers: { origin: 'https://other.test', cookie: `wtm_session=${token}` },
      payload: { currentPassword: password },
    });
    assert.equal(foreign.statusCode, 403);
    const plain = await f.app.inject({
      method: 'POST',
      url: '/api/v1/accounts/current/recovery-code',
      headers: { origin, 'content-type': 'text/plain' },
      payload: password,
    });
    assert.equal(plain.statusCode, 415);
    assert.equal(f.rotations.length, 0);
  } finally {
    await f.app.close();
  }
});

test('anonymous recovery permits at most five attempts per hour', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/v1/account-recovery',
        headers: { origin: 'https://whatthemake.test' },
        payload: {
          email: 'buyer@example.test',
          code: 'b'.repeat(43),
          newPassword: 'New password 4567',
        },
      });
      assert.equal(response.statusCode, attempt < 5 ? 401 : 429, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    assert.equal(f.recoveries.length, 5);
  } finally {
    await f.app.close();
  }
});
