import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { createPostgresDatabase } from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import {
  createIdentityService,
  hashSessionToken,
} from '../src/identity/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://whatthemake.test';
const cookieName = '__Host-wtm_session';
const password = 'correct horse battery staple';

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return header.split(';', 1)[0] ?? '';
}

test(
  'guest and account sessions enforce ownership and secure cookie auth',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 4,
      applicationName: 'wtm-identity-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(
      'TRUNCATE wtm_identity_sessions, wtm_guests, wtm_accounts CASCADE',
    );

    const app = await buildApp({
      database,
      trustProxy: true,
      identity: {
        service: createIdentityService({
          repository: database.identity,
          passwordHasher: createPasswordHasher({
            cost: 1_024,
            blockSize: 8,
            parallelization: 1,
          }),
        }),
        publicOrigin: origin,
        cookieName,
        secureCookie: true,
      },
      onClose: () => database.close(),
    });

    try {
      const csrfRejected = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
      });
      assert.equal(csrfRejected.statusCode, 403);
      assert.equal(csrfRejected.json().error.code, 'FORBIDDEN');

      const guestA = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.10' },
      });
      assert.equal(guestA.statusCode, 201);
      assert.equal(guestA.json().principal.kind, 'GUEST');
      assert.match(String(guestA.headers['set-cookie']), /HttpOnly/i);
      assert.match(String(guestA.headers['set-cookie']), /Secure/i);
      assert.match(String(guestA.headers['set-cookie']), /SameSite=Lax/i);
      const guestACookie = cookieFrom(guestA);
      const guestAToken = guestACookie.slice(cookieName.length + 1);

      const guestB = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.11' },
      });
      const guestBCookie = cookieFrom(guestB);

      const deleteGuestA = await app.inject({
        method: 'DELETE',
        url: '/api/v1/guest-sessions/current',
        headers: { origin, cookie: guestACookie },
      });
      assert.equal(deleteGuestA.statusCode, 204);

      const guestBStillExists = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: guestBCookie },
      });
      assert.equal(guestBStillExists.json().principal.kind, 'GUEST');

      const deleteGuestAAgain = await app.inject({
        method: 'DELETE',
        url: '/api/v1/guest-sessions/current',
        headers: { origin, cookie: guestACookie },
      });
      assert.equal(deleteGuestAAgain.statusCode, 204);

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { origin, cookie: guestBCookie },
        payload: { email: 'Buyer@Example.RU', password },
      });
      assert.equal(register.statusCode, 201);
      assert.equal(register.json().principal.kind, 'ACCOUNT');
      assert.equal(register.json().principal.email, 'buyer@example.ru');
      const accountCookie = cookieFrom(register);

      const accountCannotDeleteGuest = await app.inject({
        method: 'DELETE',
        url: '/api/v1/guest-sessions/current',
        headers: { origin, cookie: accountCookie },
      });
      assert.equal(accountCannotDeleteGuest.statusCode, 403);

      const transferredGuestIsRevoked = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: guestBCookie },
      });
      assert.equal(
        transferredGuestIsRevoked.json().principal.kind,
        'ANONYMOUS',
      );

      const stored = await adminPool.query<{
        password_hash: string;
        token_hash: string;
        expires_at: Date | null;
      }>(`
        SELECT account.password_hash, session.token_hash, session.expires_at
        FROM wtm_accounts AS account
        JOIN wtm_identity_sessions AS session ON session.account_id = account.id
        WHERE account.email_normalized = 'buyer@example.ru'
      `);
      assert.match(stored.rows[0]?.password_hash ?? '', /^scrypt\$/);
      assert.notEqual(stored.rows[0]?.password_hash, password);
      assert.notEqual(stored.rows[0]?.token_hash.trim(), guestAToken);
      assert.ok(stored.rows[0]?.expires_at instanceof Date);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { origin, 'x-forwarded-for': '192.0.2.12' },
        payload: { email: 'buyer@example.ru', password },
      });
      assert.equal(duplicate.statusCode, 409);

      const logout = await app.inject({
        method: 'DELETE',
        url: '/api/v1/account-sessions/current',
        headers: { origin, cookie: accountCookie },
      });
      assert.equal(logout.statusCode, 204);

      const missingAccount = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.20' },
        payload: { email: 'missing@example.ru', password },
      });
      const unsupportedMediaType = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: {
          origin,
          'content-type': 'text/plain',
          'x-forwarded-for': '192.0.2.21',
        },
        payload: JSON.stringify({ email: 'buyer@example.ru', password }),
      });
      assert.equal(unsupportedMediaType.statusCode, 415);
      assert.equal(unsupportedMediaType.json().error.code, 'VALIDATION_ERROR');
      const wrongPassword = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.20' },
        payload: {
          email: 'buyer@example.ru',
          password: 'wrong password value',
        },
      });
      assert.equal(missingAccount.statusCode, 401);
      assert.equal(wrongPassword.statusCode, 401);
      assert.equal(
        missingAccount.json().error.message,
        wrongPassword.json().error.message,
      );

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.20' },
        payload: { email: 'buyer@example.ru', password },
      });
      assert.equal(login.statusCode, 200);
      const activeCookie = cookieFrom(login);

      await adminPool.query(
        "UPDATE wtm_accounts SET status = 'BLOCKED' WHERE email_normalized = $1",
        ['buyer@example.ru'],
      );
      const blockedSession = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: activeCookie },
      });
      assert.equal(blockedSession.json().principal.kind, 'ANONYMOUS');

      const blockedLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.20' },
        payload: { email: 'buyer@example.ru', password },
      });
      assert.equal(blockedLogin.statusCode, 401);
      assert.equal(
        blockedLogin.json().error.message,
        missingAccount.json().error.message,
      );

      const fifthLoginAttempt = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.20' },
        payload: {
          email: 'buyer@example.ru',
          password: 'another wrong password',
        },
      });
      assert.equal(fifthLoginAttempt.statusCode, 401);
      const rateLimited = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.20' },
        payload: { email: 'buyer@example.ru', password },
      });
      assert.equal(rateLimited.statusCode, 429);
      assert.equal(rateLimited.json().error.code, 'RATE_LIMITED');

      const tokenRows = await adminPool.query<{ token_hash: string }>(
        'SELECT token_hash FROM wtm_identity_sessions',
      );
      assert.equal(
        tokenRows.rows.some(
          ({ token_hash }) => token_hash.trim() === guestAToken,
        ),
        false,
      );
      assert.equal(
        tokenRows.rows.some(
          ({ token_hash }) =>
            token_hash.trim() === hashSessionToken(guestAToken),
        ),
        true,
      );
    } finally {
      await app.close();
      await adminPool.end();
    }
  },
);
