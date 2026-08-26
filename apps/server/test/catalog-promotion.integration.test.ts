import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import type { CatalogPromotionIdentity } from '@wtm/contracts';
import type {
  CatalogPromotionCaseId,
  ProductObservationConfirmationId,
} from '@wtm/domain';
import { createPostgresDatabase } from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createCatalogLookupService } from '../src/catalog/service.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { createIdentityService } from '../src/identity/service.js';
import { createProductObservationService } from '../src/product-observations/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://whatthemake.test';
const cookieName = '__Host-wtm_session';
const password = 'correct horse battery staple';
const conflictGtin = '5901234123457';
const raceGtin = '4006381333931';

const agreedIdentity: CatalogPromotionIdentity = {
  brandName: 'Lash Lab',
  familyName: 'Focus',
  variantName: 'Black / 10 ml',
  shadeName: 'Black',
  netQuantity: { value: '10', unit: 'MILLILITER' },
  isWaterproof: false,
};

const conflictingIdentity: CatalogPromotionIdentity = {
  ...agreedIdentity,
  variantName: 'Black / 10 ml / waterproof',
  isWaterproof: true,
};

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return header.split(';', 1)[0] ?? '';
}

test(
  'catalog promotion requires distinct accounts, quarantines conflicts, and publishes race once',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 8,
      applicationName: 'wtm-catalog-promotion-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(`
      TRUNCATE
        wtm_catalog_promotion_cases,
        wtm_product_observations,
        wtm_media_recovery_jobs,
        wtm_media_assets,
        wtm_media_collections,
        wtm_product_claims,
        wtm_formula_revisions,
        wtm_product_barcodes,
        wtm_product_variants,
        wtm_product_families,
        wtm_catalog_provenance,
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
    const observations = createProductObservationService({
      identity,
      repository: database.productObservations,
    });
    const app = await buildApp({
      database,
      trustProxy: true,
      catalog: {
        service: createCatalogLookupService({ repository: database.catalog }),
      },
      identity: {
        service: identity,
        publicOrigin: origin,
        cookieName,
        secureCookie: true,
      },
      productObservations: {
        service: observations,
        publicOrigin: origin,
        cookieName,
      },
      onClose: () => database.close(),
    });

    const register = async (email: string, guestCookie = '') => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: {
          origin,
          ...(guestCookie ? { cookie: guestCookie } : {}),
          'content-type': 'application/json',
        },
        payload: { email, password },
      });
      assert.equal(response.statusCode, 201);
      return {
        cookie: cookieFrom(response),
        accountId: response.json().principal.accountId as string,
      };
    };
    const login = async (email: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/account-sessions',
        headers: { origin, 'content-type': 'application/json' },
        payload: { email, password },
      });
      assert.equal(response.statusCode, 200);
      return cookieFrom(response);
    };
    const createObservation = async (cookie: string, gtin: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/product-observations',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
        },
        payload: { gtin },
      });
      assert.ok([200, 201].includes(response.statusCode));
      return response.json().observation.observationId as string;
    };
    const confirm = (
      cookie: string,
      observationId: string,
      catalogIdentity: CatalogPromotionIdentity,
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/product-observations/${observationId}/confirmations`,
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
        },
        payload: { identity: catalogIdentity },
      });

    try {
      const guest = await app.inject({
        method: 'POST',
        url: '/api/v1/guest-sessions',
        headers: { origin, 'x-forwarded-for': '192.0.2.51' },
      });
      const guestCookie = cookieFrom(guest);
      const guestObservationId = await createObservation(
        guestCookie,
        conflictGtin,
      );
      const guestConfirmation = await confirm(
        guestCookie,
        guestObservationId,
        agreedIdentity,
      );
      assert.equal(guestConfirmation.statusCode, 403);

      const accountA = await register('promotion-a@example.ru', guestCookie);
      const accountASecondToken = await login('promotion-a@example.ru');
      const firstConfirmation = await confirm(
        accountA.cookie,
        guestObservationId,
        agreedIdentity,
      );
      assert.equal(firstConfirmation.statusCode, 201);
      assert.deepEqual(firstConfirmation.json().promotion, {
        state: 'WAITING_FOR_MATCH',
        matchingAccountCount: 1,
        productVariantId: null,
      });

      const sameAccountAgain = await confirm(
        accountASecondToken,
        guestObservationId,
        { ...agreedIdentity, brandName: '  lash   lab ' },
      );
      assert.equal(sameAccountAgain.statusCode, 200);
      assert.equal(sameAccountAgain.json().promotion.matchingAccountCount, 1);

      const accountB = await register('promotion-b@example.ru');
      const accountBConflictObservation = await createObservation(
        accountB.cookie,
        conflictGtin,
      );
      const conflict = await confirm(
        accountB.cookie,
        accountBConflictObservation,
        conflictingIdentity,
      );
      assert.equal(conflict.statusCode, 202);
      assert.equal(conflict.json().promotion.state, 'NEEDS_MODERATION');

      const stillPrivate = await app.inject({
        method: 'GET',
        url: `/api/v1/catalog/barcodes/${conflictGtin}`,
      });
      assert.equal(stillPrivate.statusCode, 404);

      const conflictRows = await adminPool.query<{
        promotion_case_id: string;
        confirmation_id: string;
        confirmation_count: number;
        account_count: number;
      }>(
        `
          SELECT
            promotion.id AS promotion_case_id,
            min(confirmation.id::text) FILTER (
              WHERE confirmation.account_id = $1
            ) AS confirmation_id,
            count(confirmation.id)::integer AS confirmation_count,
            count(DISTINCT confirmation.account_id)::integer AS account_count
          FROM wtm_catalog_promotion_cases AS promotion
          JOIN wtm_product_observation_confirmations AS confirmation
            ON confirmation.promotion_case_id = promotion.id
          WHERE promotion.gtin14 = $2
          GROUP BY promotion.id
        `,
        [accountA.accountId, conflictGtin.padStart(14, '0')],
      );
      const conflictRow = conflictRows.rows[0];
      assert.ok(conflictRow);
      assert.ok(conflictRow.confirmation_id);
      assert.equal(conflictRow.confirmation_count, 2);
      assert.equal(conflictRow.account_count, 2);

      const moderated =
        await database.productObservations.moderateCatalogPromotion({
          promotionCaseId:
            conflictRow.promotion_case_id as CatalogPromotionCaseId,
          confirmationId:
            conflictRow.confirmation_id as ProductObservationConfirmationId,
          moderatorAccountId: accountB.accountId,
        });
      assert.equal(moderated.kind, 'PUBLISHED');
      const moderatedLookup = await app.inject({
        method: 'GET',
        url: `/api/v1/catalog/barcodes/${conflictGtin}`,
      });
      assert.equal(moderatedLookup.statusCode, 200);
      assert.equal(moderatedLookup.json().variant.brandName, 'Lash Lab');
      assert.equal(
        moderatedLookup.json().variant.identitySources.barcode.sourceKind,
        'ADMIN',
      );
      assert.doesNotMatch(
        JSON.stringify(moderatedLookup.json()),
        /accountId|email|observationId|mediaCollection/i,
      );

      const accountAObservation = await createObservation(
        accountA.cookie,
        raceGtin,
      );
      const accountBObservation = await createObservation(
        accountB.cookie,
        raceGtin,
      );
      const [raceA, raceB] = await Promise.all([
        confirm(accountA.cookie, accountAObservation, agreedIdentity),
        confirm(accountB.cookie, accountBObservation, {
          ...agreedIdentity,
          brandName: ' lash  lab ',
          netQuantity: { value: '10.0000', unit: 'MILLILITER' },
        }),
      ]);
      assert.deepEqual([raceA.statusCode, raceB.statusCode].sort(), [201, 201]);
      assert.ok(
        [raceA, raceB].some(
          (response) => response.json().promotion.state === 'PUBLISHED',
        ),
      );

      const raceLookup = await app.inject({
        method: 'GET',
        url: `/api/v1/catalog/barcodes/${raceGtin}`,
      });
      assert.equal(raceLookup.statusCode, 200);
      assert.equal(
        raceLookup.json().variant.identitySources.barcode.sourceKind,
        'USER_OBSERVATION',
      );
      const raceRows = await adminPool.query<{
        confirmations: number;
        variants: number;
        barcodes: number;
      }>(
        `
          SELECT
            (
              SELECT count(*)::integer
              FROM wtm_product_observation_confirmations AS confirmation
              JOIN wtm_catalog_promotion_cases AS promotion
                ON promotion.id = confirmation.promotion_case_id
              WHERE promotion.gtin14 = $1
            ) AS confirmations,
            (
              SELECT count(*)::integer
              FROM wtm_product_variants AS variant
              JOIN wtm_product_barcodes AS barcode
                ON barcode.variant_id = variant.id
              WHERE barcode.gtin14 = $1
            ) AS variants,
            (
              SELECT count(*)::integer
              FROM wtm_product_barcodes
              WHERE gtin14 = $1
            ) AS barcodes
        `,
        [raceGtin.padStart(14, '0')],
      );
      assert.deepEqual(raceRows.rows[0], {
        confirmations: 2,
        variants: 1,
        barcodes: 1,
      });
    } finally {
      await app.close();
      await adminPool.end();
    }
  },
);
