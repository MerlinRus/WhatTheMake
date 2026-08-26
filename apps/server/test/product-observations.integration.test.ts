import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import {
  createLocalMediaStorage,
  createPostgresDatabase,
} from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMediaService } from '../src/media/service.js';
import { createProductObservationService } from '../src/product-observations/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://whatthemake.test';
const cookieName = '__Host-wtm_session';
const password = 'correct horse battery staple';
const gtin = '5901234123457';

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return header.split(';', 1)[0] ?? '';
}

function jpeg(seed: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, 0xff, 0xd9]);
}

test(
  'unknown product observation stays private and follows guest into account',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const mediaRoot = await mkdtemp(join(tmpdir(), 'wtm-observation-'));
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 5,
      applicationName: 'wtm-product-observation-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(`
      TRUNCATE
        wtm_product_observations,
        wtm_media_recovery_jobs,
        wtm_media_assets,
        wtm_media_collections,
        wtm_identity_sessions,
        wtm_guests,
        wtm_accounts
      CASCADE
    `);

    const identity = createIdentityService({
      repository: database.identity,
      passwordHasher: createPasswordHasher({
        cost: 1_024,
        blockSize: 8,
        parallelization: 1,
      }),
    });
    const media = createMediaService({
      identity,
      repository: database.media,
      storage: createLocalMediaStorage({ rootDirectory: mediaRoot }),
      maxBytes: 1024,
      recoveryDelayMs: 60_000,
    });
    const observations = createProductObservationService({
      identity,
      repository: database.productObservations,
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
      media: {
        service: media,
        publicOrigin: origin,
        cookieName,
        maxBytes: 1024,
      },
      productObservations: {
        service: observations,
        publicOrigin: origin,
        cookieName,
      },
      onClose: () => database.close(),
    });

    try {
      const noSession = await app.inject({
        method: 'POST',
        url: '/api/v1/product-observations',
        headers: { origin, 'content-type': 'application/json' },
        payload: { gtin },
      });
      assert.equal(noSession.statusCode, 401);

      const guestA = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.41' },
      });
      const guestACookie = cookieFrom(guestA);
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/product-observations',
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'application/json',
        },
        payload: { gtin },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.headers['cache-control'], 'private, no-store');
      assert.equal(created.json().observation.barcode.gtin14, '05901234123457');
      const observationId = created.json().observation.observationId;
      const collectionId =
        created.json().observation.mediaCollection.collectionId;

      const reused = await app.inject({
        method: 'POST',
        url: '/api/v1/product-observations',
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'application/json',
        },
        payload: { gtin },
      });
      assert.equal(reused.statusCode, 200);
      assert.equal(reused.json().observation.observationId, observationId);
      assert.equal(
        reused.json().observation.mediaCollection.collectionId,
        collectionId,
      );

      const guestB = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.42' },
      });
      const guestBCookie = cookieFrom(guestB);
      const hiddenFromOtherGuest = await app.inject({
        method: 'GET',
        url: `/api/v1/product-observations/${observationId}`,
        headers: { cookie: guestBCookie },
      });
      assert.equal(hiddenFromOtherGuest.statusCode, 404);

      const roles = [
        'FRONT',
        'INGREDIENTS',
        'CLAIMS',
        'BARCODE',
        'PRICE_TAG',
      ] as const;
      for (const [index, role] of roles.entries()) {
        const uploaded = await app.inject({
          method: 'POST',
          url: `/api/v1/media-collections/${collectionId}/assets?role=${role}`,
          headers: {
            origin,
            cookie: guestACookie,
            'content-type': 'image/jpeg',
          },
          payload: jpeg(index),
        });
        assert.equal(uploaded.statusCode, 201);
      }

      const captured = await app.inject({
        method: 'GET',
        url: `/api/v1/product-observations/${observationId}`,
        headers: { cookie: guestACookie },
      });
      assert.equal(captured.statusCode, 200);
      assert.deepEqual(
        new Set(
          captured
            .json()
            .observation.mediaCollection.assets.map(
              (asset: { role: string }) => asset.role,
            ),
        ),
        new Set(roles),
      );

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { origin, cookie: guestACookie },
        payload: { email: 'observation-owner@example.ru', password },
      });
      assert.equal(register.statusCode, 201);
      const accountCookie = cookieFrom(register);

      const transferred = await app.inject({
        method: 'GET',
        url: `/api/v1/product-observations/${observationId}`,
        headers: { cookie: accountCookie },
      });
      assert.equal(transferred.statusCode, 200);
      assert.equal(
        transferred.json().observation.mediaCollection.assets.length,
        5,
      );

      const accountReuse = await app.inject({
        method: 'POST',
        url: '/api/v1/product-observations',
        headers: {
          origin,
          cookie: accountCookie,
          'content-type': 'application/json',
        },
        payload: { gtin },
      });
      assert.equal(accountReuse.statusCode, 200);
      assert.equal(
        accountReuse.json().observation.observationId,
        observationId,
      );

      const rows = await adminPool.query<{
        row_count: number;
        owner_kind: string;
      }>(
        `
          SELECT count(*)::integer AS row_count, min(owner_kind) AS owner_kind
          FROM wtm_product_observations
        `,
      );
      assert.equal(rows.rows[0]?.row_count, 1);
      assert.equal(rows.rows[0]?.owner_kind, 'GUEST');
    } finally {
      await app.close();
      await adminPool.end();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  },
);
