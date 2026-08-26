import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { createPostgresDatabase } from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMascaraPreferencesService } from '../src/preferences/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://whatthemake.test';
const cookieName = '__Host-wtm_session';
const password = 'correct horse battery staple';

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return header.split(';', 1)[0] ?? '';
}

const personalized = {
  mode: 'PERSONALIZED',
  goals: ['VOLUME', 'SEPARATION'],
  waterproof: 'NO_PREFERENCE',
  removal: 'EASY_REQUIRED',
  sensitiveEyes: true,
  contactLenses: false,
  avoidedIngredients: ['  paraffin ', 'PARAFFIN', 'CI   77499'],
} as const;

test(
  'mascara briefs keep guest data ephemeral and version account profiles',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 4,
      applicationName: 'wtm-preferences-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(
      'TRUNCATE wtm_mascara_preference_versions, wtm_identity_sessions, wtm_guests, wtm_accounts CASCADE',
    );

    const identity = createIdentityService({
      repository: database.identity,
      passwordHasher: createPasswordHasher({
        cost: 1_024,
        blockSize: 8,
        parallelization: 1,
      }),
    });
    const app = await buildApp({
      database,
      trustProxy: true,
      identity: {
        service: identity,
        publicOrigin: origin,
        cookieName,
        secureCookie: true,
      },
      mascaraPreferences: {
        service: createMascaraPreferencesService({
          identity,
          repository: database.preferences,
          now: () => new Date('2026-08-26T07:00:00.000Z'),
        }),
        publicOrigin: origin,
        cookieName,
      },
      onClose: () => database.close(),
    });

    try {
      const anonymous = await app.inject({
        method: 'POST',
        url: '/api/v1/mascara-briefs',
        headers: { origin },
        payload: personalized,
      });
      assert.equal(anonymous.statusCode, 401);

      const guest = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin },
      });
      const guestCookie = cookieFrom(guest);

      const guestBrief = await app.inject({
        method: 'POST',
        url: '/api/v1/mascara-briefs',
        headers: { origin, cookie: guestCookie },
        payload: personalized,
      });
      assert.equal(guestBrief.statusCode, 200);
      assert.deepEqual(guestBrief.json().brief.avoidedIngredients, [
        'PARAFFIN',
        'CI 77499',
      ]);
      assert.equal(guestBrief.json().brief.source, 'EPHEMERAL');
      assert.equal(guestBrief.json().brief.profileVersion, null);

      const guestRows = await adminPool.query(
        'SELECT id FROM wtm_mascara_preference_versions',
      );
      assert.equal(guestRows.rowCount, 0);

      const guestCannotReadProfile = await app.inject({
        method: 'GET',
        url: '/api/v1/mascara-preferences/current',
        headers: { cookie: guestCookie },
      });
      assert.equal(guestCannotReadProfile.statusCode, 403);

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { origin, cookie: guestCookie },
        payload: { email: 'brief-owner@example.ru', password },
      });
      assert.equal(register.statusCode, 201);
      const accountCookie = cookieFrom(register);

      const csrfRejected = await app.inject({
        method: 'POST',
        url: '/api/v1/mascara-preferences',
        headers: { cookie: accountCookie },
        payload: personalized,
      });
      assert.equal(csrfRejected.statusCode, 403);

      const firstSave = await app.inject({
        method: 'POST',
        url: '/api/v1/mascara-preferences',
        headers: { origin, cookie: accountCookie },
        payload: personalized,
      });
      assert.equal(firstSave.statusCode, 201);
      assert.equal(firstSave.json().brief.profileVersion, 1);
      assert.equal(firstSave.json().brief.source, 'ACCOUNT_PROFILE');

      const secondSave = await app.inject({
        method: 'POST',
        url: '/api/v1/mascara-preferences',
        headers: { origin, cookie: accountCookie },
        payload: {
          mode: 'UNKNOWN_GOALS',
          waterproof: 'AVOID',
          removal: 'NO_PREFERENCE',
          sensitiveEyes: true,
          contactLenses: true,
          avoidedIngredients: ['Nickel'],
        },
      });
      assert.equal(secondSave.statusCode, 201);
      assert.equal(secondSave.json().brief.profileVersion, 2);
      assert.deepEqual(secondSave.json().brief.goals, []);

      const current = await app.inject({
        method: 'GET',
        url: '/api/v1/mascara-preferences/current',
        headers: { cookie: accountCookie },
      });
      assert.equal(current.statusCode, 200);
      assert.equal(current.json().preference.profileVersion, 2);
      assert.equal(current.json().preference.mode, 'UNKNOWN_GOALS');

      const versions = await adminPool.query<{
        profile_version: number;
        mode: string;
        goals: string[];
      }>(`
        SELECT profile_version, mode, goals
        FROM wtm_mascara_preference_versions
        ORDER BY profile_version
      `);
      assert.deepEqual(
        versions.rows.map(({ profile_version, mode, goals }) => ({
          profileVersion: profile_version,
          mode,
          goals,
        })),
        [
          {
            profileVersion: 1,
            mode: 'PERSONALIZED',
            goals: ['VOLUME', 'SEPARATION'],
          },
          { profileVersion: 2, mode: 'UNKNOWN_GOALS', goals: [] },
        ],
      );

      const invalidUnknownGoals = await app.inject({
        method: 'POST',
        url: '/api/v1/mascara-briefs',
        headers: { origin, cookie: accountCookie },
        payload: { ...personalized, mode: 'UNKNOWN_GOALS' },
      });
      assert.equal(invalidUnknownGoals.statusCode, 400);

      const secondAccount = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { origin },
        payload: { email: 'other@example.ru', password },
      });
      assert.equal(secondAccount.statusCode, 201);
      const otherCurrent = await app.inject({
        method: 'GET',
        url: '/api/v1/mascara-preferences/current',
        headers: { cookie: cookieFrom(secondAccount) },
      });
      assert.equal(otherCurrent.statusCode, 200);
      assert.equal(otherCurrent.json().preference, null);
    } finally {
      await app.close();
      await adminPool.end();
    }
  },
);
