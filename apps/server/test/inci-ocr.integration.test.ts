import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import type { OcrProvider } from '@wtm/domain';
import {
  createLocalMediaStorage,
  createPostgresDatabase,
} from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { createIdentityService } from '../src/identity/service.js';
import { createInciCorrectionService } from '../src/inci-corrections/service.js';
import { createMediaService } from '../src/media/service.js';
import { createProductObservationService } from '../src/product-observations/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://whatthemake.test';
const cookieName = '__Host-wtm_session';

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return header.split(';', 1)[0] ?? '';
}

function jpeg(seed: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, 0xff, 0xd9]);
}

test(
  'OCR persists immutable provenance and hides foreign or wrong-role media',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const mediaRoot = await mkdtemp(join(tmpdir(), 'wtm-inci-ocr-'));
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 5,
      applicationName: 'wtm-inci-ocr-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(`
      TRUNCATE
        wtm_product_observation_inci_revisions,
        wtm_product_observations,
        wtm_media_recovery_jobs,
        wtm_media_assets,
        wtm_media_collections,
        wtm_ocr_provider_cache,
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
      maxBytes: 1_024,
      recoveryDelayMs: 60_000,
    });
    const observations = createProductObservationService({
      identity,
      repository: database.productObservations,
    });
    let ocrCalls = 0;
    const ocr: OcrProvider = {
      providerId: 'TEST_OCR',
      version: 'fixture-v1',
      async recognize(request) {
        ocrCalls += 1;
        return request.imageBytes.includes(9)
          ? { kind: 'FAILED', code: 'OCR_RATE_LIMITED', retryable: true }
          : { kind: 'SUCCEEDED', text: 'Aqua, Glycerin' };
      },
    };
    const app = await buildApp({
      database,
      trustProxy: true,
      identity: {
        service: identity,
        publicOrigin: origin,
        cookieName,
        secureCookie: true,
      },
      inciCorrections: {
        service: createInciCorrectionService({
          identity,
          repository: database.productObservationInci,
          dictionary: database.inciDictionary,
          ocr,
          media,
          observations,
        }),
        publicOrigin: origin,
        cookieName,
      },
      media: {
        service: media,
        publicOrigin: origin,
        cookieName,
        maxBytes: 1_024,
      },
      productObservations: {
        service: observations,
        publicOrigin: origin,
        cookieName,
      },
      onClose: () => database.close(),
    });

    const createGuest = async (ip: string): Promise<string> =>
      cookieFrom(
        await app.inject({
          method: 'POST',
          url: '/api/v1/guest-sessions',
          headers: { origin, 'x-forwarded-for': ip },
        }),
      );
    const createObservation = async (cookie: string, gtin: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/product-observations',
        headers: { origin, cookie, 'content-type': 'application/json' },
        payload: { gtin },
      });
      assert.equal(response.statusCode, 201);
      return response.json().observation;
    };
    const upload = async (
      cookie: string,
      collectionId: string,
      role: 'FRONT' | 'INGREDIENTS',
      seed: number,
    ): Promise<string> => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/media-collections/${collectionId}/assets?role=${role}`,
        headers: {
          origin,
          cookie,
          'content-type': 'image/jpeg',
        },
        payload: jpeg(seed),
      });
      assert.equal(response.statusCode, 201);
      return response.json().asset.assetId;
    };
    const recognize = (
      cookie: string,
      observationId: string,
      mediaAssetId: string,
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/product-observations/${observationId}/inci-ocr`,
        headers: { origin, cookie, 'content-type': 'application/json' },
        payload: { mediaAssetId },
      });

    try {
      const guestA = await createGuest('192.0.2.81');
      const observation = await createObservation(guestA, '5901234123457');
      const ingredientsAssetId = await upload(
        guestA,
        observation.mediaCollection.collectionId,
        'INGREDIENTS',
        1,
      );

      const created = await recognize(
        guestA,
        observation.observationId,
        ingredientsAssetId,
      );
      assert.equal(created.statusCode, 201);
      assert.equal(created.headers['cache-control'], 'private, no-store');
      assert.equal(created.json().revision.authorKind, 'SYSTEM');
      assert.equal(created.json().revision.sourceText, 'Aqua, Glycerin');
      assert.deepEqual(created.json().revision.source, {
        kind: 'OCR',
        mediaAssetId: ingredientsAssetId,
        providerId: 'TEST_OCR',
        providerVersion: 'fixture-v1',
      });

      const repeated = await recognize(
        guestA,
        observation.observationId,
        ingredientsAssetId,
      );
      assert.equal(repeated.statusCode, 200);
      assert.equal(repeated.json().resultKind, 'REUSED');
      assert.equal(
        repeated.json().revision.revisionId,
        created.json().revision.revisionId,
      );

      const provenance = await adminPool.query(
        `
          SELECT
            source_kind,
            author_kind,
            guest_id,
            account_id,
            media_asset_id,
            provider_id,
            provider_version
          FROM wtm_product_observation_inci_revisions
          WHERE id = $1
        `,
        [created.json().revision.revisionId],
      );
      assert.deepEqual(provenance.rows[0], {
        source_kind: 'OCR',
        author_kind: 'SYSTEM',
        guest_id: null,
        account_id: null,
        media_asset_id: ingredientsAssetId,
        provider_id: 'TEST_OCR',
        provider_version: 'fixture-v1',
      });

      const frontObservation = await createObservation(guestA, '4006381333931');
      const frontAssetId = await upload(
        guestA,
        frontObservation.mediaCollection.collectionId,
        'FRONT',
        2,
      );
      const beforeHiddenChecks = ocrCalls;
      assert.equal(
        (await recognize(guestA, frontObservation.observationId, frontAssetId))
          .statusCode,
        404,
      );

      const guestB = await createGuest('192.0.2.82');
      const foreignObservation = await createObservation(
        guestB,
        '5901234123457',
      );
      const foreignAssetId = await upload(
        guestB,
        foreignObservation.mediaCollection.collectionId,
        'INGREDIENTS',
        3,
      );
      assert.equal(
        (await recognize(guestA, observation.observationId, foreignAssetId))
          .statusCode,
        404,
      );
      assert.equal(ocrCalls, beforeHiddenChecks);

      const limitedObservation = await createObservation(guestA, '96385074');
      const limitedAssetId = await upload(
        guestA,
        limitedObservation.mediaCollection.collectionId,
        'INGREDIENTS',
        9,
      );
      const limited = await recognize(
        guestA,
        limitedObservation.observationId,
        limitedAssetId,
      );
      assert.equal(limited.statusCode, 429);
      assert.deepEqual(limited.json().error.details, {
        reason: 'OCR_RATE_LIMITED',
        retryable: true,
      });
    } finally {
      await app.close();
      await adminPool.end();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  },
);
