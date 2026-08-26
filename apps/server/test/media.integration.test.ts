import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import {
  createLocalMediaStorage,
  createMediaRecoveryWorker,
  createPostgresDatabase,
} from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMediaService } from '../src/media/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://whatthemake.test';
const cookieName = '__Host-wtm_session';
const password = 'correct horse battery staple';
const maxBytes = 32;

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return header.split(';', 1)[0] ?? '';
}

function jpeg(seed = 0): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, 0xff, 0xd9]);
}

test(
  'private media enforces ownership, limits, transfer, and binary lifecycle',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const mediaRoot = await mkdtemp(join(tmpdir(), 'wtm-media-integration-'));
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 5,
      applicationName: 'wtm-media-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(
      'TRUNCATE wtm_media_recovery_jobs, wtm_media_assets, wtm_media_collections, wtm_mascara_preference_versions, wtm_identity_sessions, wtm_guests, wtm_accounts CASCADE',
    );

    const identity = createIdentityService({
      repository: database.identity,
      passwordHasher: createPasswordHasher({
        cost: 1_024,
        blockSize: 8,
        parallelization: 1,
      }),
    });
    const mediaStorage = createLocalMediaStorage({
      rootDirectory: mediaRoot,
    });
    const recoveryWorker = createMediaRecoveryWorker({
      repository: database.media,
      storage: mediaStorage,
      pollIntervalMs: 60_000,
      leaseMs: 30_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
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
        service: createMediaService({
          identity,
          repository: database.media,
          storage: mediaStorage,
          maxBytes,
          recoveryDelayMs: 60_000,
        }),
        publicOrigin: origin,
        cookieName,
        maxBytes,
      },
      onClose: () => database.close(),
    });

    try {
      const csrfRejected = await app.inject({
        method: 'POST',
        url: '/api/v1/media-collections',
      });
      assert.equal(csrfRejected.statusCode, 403);

      const guestA = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.31' },
      });
      const guestACookie = cookieFrom(guestA);
      const createCollection = await app.inject({
        method: 'POST',
        url: '/api/v1/media-collections',
        headers: { origin, cookie: guestACookie },
      });
      assert.equal(createCollection.statusCode, 201);
      const collectionId = createCollection.json().collection.collectionId;

      const mismatch = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=FRONT`,
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'image/png',
        },
        payload: jpeg(),
      });
      assert.equal(mismatch.statusCode, 415);

      const unsupportedType = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=FRONT`,
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'text/plain',
        },
        payload: 'not an image',
      });
      assert.equal(unsupportedType.statusCode, 415);
      assert.equal(unsupportedType.json().error.code, 'VALIDATION_ERROR');

      const oversized = Buffer.alloc(maxBytes + 1, 1);
      oversized.set([0xff, 0xd8, 0xff], 0);
      const tooLarge = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=FRONT`,
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'image/jpeg',
        },
        payload: oversized,
      });
      assert.equal(tooLarge.statusCode, 413);

      const upload = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=INGREDIENTS`,
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'image/jpeg',
        },
        payload: jpeg(),
      });
      assert.equal(upload.statusCode, 201);
      const assetId = upload.json().asset.assetId;
      assert.equal('sha256' in upload.json().asset, false);

      const duplicateRole = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=INGREDIENTS`,
        headers: {
          origin,
          cookie: guestACookie,
          'content-type': 'image/jpeg',
        },
        payload: jpeg(8),
      });
      assert.equal(duplicateRole.statusCode, 409);
      assert.equal(duplicateRole.json().error.code, 'CONFLICT');

      const ownerRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { cookie: guestACookie },
      });
      assert.equal(ownerRead.statusCode, 200);
      assert.equal(ownerRead.headers['content-type'], 'image/jpeg');
      assert.equal(ownerRead.headers['cache-control'], 'private, no-store');
      assert.deepEqual(ownerRead.rawPayload, jpeg());

      const assetPath = join(
        mediaRoot,
        assetId.slice(0, 2),
        assetId.slice(2, 4),
        assetId,
      );
      await writeFile(assetPath, jpeg(99));
      const corruptRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { cookie: guestACookie },
      });
      assert.equal(corruptRead.statusCode, 503);
      await writeFile(assetPath, jpeg());

      const guestB = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.32' },
      });
      const guestBCookie = cookieFrom(guestB);
      const otherRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { cookie: guestBCookie },
      });
      assert.equal(otherRead.statusCode, 404);

      const otherCollection = await app.inject({
        method: 'GET',
        url: `/api/v1/media-collections/${collectionId}`,
        headers: { cookie: guestBCookie },
      });
      assert.equal(otherCollection.statusCode, 404);

      const otherUpload = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=CLAIMS`,
        headers: {
          origin,
          cookie: guestBCookie,
          'content-type': 'image/jpeg',
        },
        payload: jpeg(1),
      });
      assert.equal(otherUpload.statusCode, 404);

      const otherDelete = await app.inject({
        method: 'DELETE',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { origin, cookie: guestBCookie },
      });
      assert.equal(otherDelete.statusCode, 204);

      const stillOwned = await app.inject({
        method: 'GET',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { cookie: guestACookie },
      });
      assert.equal(stillOwned.statusCode, 200);

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { origin, cookie: guestACookie },
        payload: { email: 'media-owner@example.ru', password },
      });
      assert.equal(register.statusCode, 201);
      const accountCookie = cookieFrom(register);

      const transferredRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { cookie: accountCookie },
      });
      assert.equal(transferredRead.statusCode, 200);

      const remainingRoles = [
        'FRONT',
        'CLAIMS',
        'BARCODE',
        'PRICE_TAG',
      ] as const;
      for (const [index, role] of remainingRoles.entries()) {
        const additional = await app.inject({
          method: 'POST',
          url: `/api/v1/media-collections/${collectionId}/assets?role=${role}`,
          headers: {
            origin,
            cookie: accountCookie,
            'content-type': 'image/jpeg',
          },
          payload: jpeg(index + 1),
        });
        assert.equal(additional.statusCode, 201);
      }

      const sixth = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=BARCODE`,
        headers: {
          origin,
          cookie: accountCookie,
          'content-type': 'image/jpeg',
        },
        payload: jpeg(9),
      });
      assert.equal(sixth.statusCode, 409);

      const collection = await app.inject({
        method: 'GET',
        url: `/api/v1/media-collections/${collectionId}`,
        headers: { cookie: accountCookie },
      });
      assert.equal(collection.statusCode, 200);
      assert.equal(collection.json().collection.assets.length, 5);

      const invalidAssetId = await app.inject({
        method: 'GET',
        url: '/api/v1/media-assets/not-a-uuid',
        headers: { cookie: accountCookie },
      });
      assert.equal(invalidAssetId.statusCode, 400);

      const deleteAsset = await app.inject({
        method: 'DELETE',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { origin, cookie: accountCookie },
      });
      assert.equal(deleteAsset.statusCode, 204);
      const deleteAgain = await app.inject({
        method: 'DELETE',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { origin, cookie: accountCookie },
      });
      assert.equal(deleteAgain.statusCode, 204);
      const deletedRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media-assets/${assetId}`,
        headers: { cookie: accountCookie },
      });
      assert.equal(deletedRead.statusCode, 404);
      assert.equal(await recoveryWorker.runOnce(), true);
      assert.equal(await recoveryWorker.runOnce(), false);

      const stored = await adminPool.query<{
        byte_size: number;
        sha256: string;
      }>('SELECT byte_size, sha256 FROM wtm_media_assets ORDER BY created_at');
      assert.equal(stored.rowCount, 5);
      assert.equal(stored.rows[0]?.byte_size, jpeg().byteLength);
      assert.match(stored.rows[0]?.sha256.trim() ?? '', /^[0-9a-f]{64}$/);

      const storedFiles = (
        await readdir(mediaRoot, { recursive: true })
      ).filter((entry) => /^[0-9a-f-]{36}$/.test(basename(String(entry))));
      assert.equal(storedFiles.length, 4);
    } finally {
      await app.close();
      await adminPool.end();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  },
);
