import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import {
  normalizeGtin,
  normalizeCatalogPromotionIdentity,
  type AuthenticatedIdentity,
  type InciSourceSha256,
} from '@wtm/domain';
import {
  createPostgresDatabase,
  createPostgresAccountErasureRepository,
} from '@wtm/infrastructure';
import { buildApp } from '../src/app.js';
import { createAccountErasureService } from '../src/account-erasure/service.js';
import { registerAccountErasureRoutes } from '../src/routes/account-erasure.js';
import {
  createIdentityService,
  hashSessionToken,
} from '../src/identity/service.js';
import { createPasswordHasher } from '../src/identity/passwords.js';
import { AppError } from '../src/errors.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const password = 'correct-account-password-123';
const origin = 'https://whatthemake.test';

test(
  'account erasure verifies password, removes all private data and preserves other owners and catalog audit',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 4,
      applicationName: 'wtm-account-erasure-test',
    });
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const hasher = createPasswordHasher({
      cost: 1024,
      blockSize: 8,
      parallelization: 1,
    });
    const identity = createIdentityService({
      repository: database.identity,
      passwordHasher: hasher,
    });
    const repository = createPostgresAccountErasureRepository(pool);
    const service = createAccountErasureService({
      identity,
      identityRepository: database.identity,
      repository,
      passwordHasher: hasher,
    });
    const app = await buildApp({ database, trustProxy: true });
    await registerAccountErasureRoutes(app, {
      service,
      publicOrigin: origin,
      cookieName: '__Host-wtm_session',
      secureCookie: true,
    });
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const email = `erase-${randomUUID()}@example.test`;
      const claimed = await identity.createGuestSession(null);
      assert.ok(claimed.token);
      const gtin = normalizeGtin('4006381333931');
      assert.equal(gtin.kind, 'VALID');
      if (gtin.kind !== 'VALID') throw new Error('Fixture GTIN invalid');
      async function privateData(
        owner: AuthenticatedIdentity,
        productGtin = gtin.gtin,
      ) {
        const { observation } =
          await database.productObservations.createOrReuse(owner, productGtin);
        const assetId = randomUUID();
        await pool.query(
          "INSERT INTO wtm_media_assets(id,collection_id,role,media_type,byte_size,sha256) VALUES ($1,$2,'INGREDIENTS','image/jpeg',12,$3)",
          [assetId, observation.mediaCollection.collectionId, 'a'.repeat(64)],
        );
        const created = await database.productObservationInci.createRevision({
          observationId: observation.observationId,
          owner,
          kind: 'USER_TRANSCRIPTION',
          sourceText: 'Aqua',
          sourceSha256: createHash('sha256')
            .update('Aqua')
            .digest('hex') as InciSourceSha256,
        });
        assert.ok('revision' in created);
        const packaging = normalizeCatalogPromotionIdentity({
          brandName: 'Fixture',
          familyName: 'Mascara',
          variantName: 'Black',
          shadeName: null,
          netQuantity: null,
          isWaterproof: null,
        });
        assert.ok(packaging);
        const snapshot = await database.privateProducts.createSnapshot({
          observationId: observation.observationId,
          owner,
          category: 'MASCARA',
          identity: packaging,
          identityConfirmed: true,
          revisionId: created.revision.revisionId,
          claimKinds: [],
          priceKopecks: null,
        });
        assert.ok('snapshot' in snapshot);
        return { observation, assetId, snapshot: snapshot.snapshot };
      }
      const guestData = await privateData(claimed.identity);
      const registered = await identity.register(
        { email, password },
        claimed.token,
      );
      assert.equal(registered.identity.kind, 'ACCOUNT');
      if (registered.identity.kind !== 'ACCOUNT')
        throw new Error('Fixture account missing');
      assert.ok(registered.token);
      const accountId = registered.identity.accountId;
      const accountGtin = normalizeGtin('5901234123457');
      if (accountGtin.kind !== 'VALID') throw new Error('Fixture GTIN invalid');
      const ownerData = await privateData(
        registered.identity,
        accountGtin.gtin,
      );
      const other = await identity.register(
        { email: `keep-${randomUUID()}@example.test`, password },
        null,
      );
      assert.equal(other.identity.kind, 'ACCOUNT');
      if (other.identity.kind !== 'ACCOUNT')
        throw new Error('Other fixture account missing');
      const otherData = await privateData(other.identity);
      const liveGuest = await identity.createGuestSession(null);
      await assert.rejects(
        service.erase(liveGuest.token, { password, confirmation: 'DELETE' }),
        (error: unknown) =>
          error instanceof AppError && error.statusCode === 403,
      );
      await assert.rejects(
        service.erase(registered.token, {
          password: 'wrong-password-12345',
          confirmation: 'DELETE',
        }),
        (error: unknown) =>
          error instanceof AppError && error.statusCode === 401,
      );
      assert.ok(
        await database.privateProducts.findOwned(
          ownerData.snapshot.snapshotId,
          registered.identity,
        ),
      );
      const credential = await database.identity.findAccountByEmail(email);
      assert.ok(credential);
      assert.equal(
        await repository.erase({
          accountId,
          expectedPasswordHash: 'old-hash-before-reset',
          sessionTokenHash: hashSessionToken(registered.token),
        }),
        'AUTH_CHANGED',
      );
      const revoked = await identity.login({ email, password }, null);
      assert.ok(revoked.token);
      await identity.logoutAccount(revoked.token);
      assert.equal(
        await repository.erase({
          accountId,
          expectedPasswordHash: credential.passwordHash,
          sessionTokenHash: hashSessionToken(revoked.token),
        }),
        'AUTH_CHANGED',
      );
      const secondSession = await identity.login({ email, password }, null);
      const provenance = {
        sourceKind: 'ADMIN' as const,
        sourceLabel: 'Erasure test published fact',
        sourceUri: null,
        sourceRecordId: null,
        observedAt: null,
        rightsStatus: 'ALLOWED' as const,
      };
      const family = await database.catalog.createFamily(
        {
          category: 'MASCARA',
          brandName: 'Fixture',
          name: 'Published Mascara',
        },
        provenance,
      );
      const variant = await database.catalog.createVariant(
        {
          productFamilyId: family.productFamilyId,
          name: 'Black',
          shadeName: null,
          netQuantityValue: null,
          netQuantityUnit: null,
          waterproof: null,
        },
        provenance,
      );
      assert.equal(variant.kind, 'CREATED');
      if (variant.kind !== 'CREATED')
        throw new Error('Fixture variant missing');
      await database.catalog.transitionFamilyStatus(
        family.productFamilyId,
        'PUBLISHED',
      );
      await database.catalog.transitionVariantStatus(
        variant.variant.productVariantId,
        'PUBLISHED',
      );
      const mine = await database.customerReviews.upsert({
        accountId,
        productVariantId: variant.variant.productVariantId,
        stars: 4,
        text: 'Мой настоящий текст отзыва для проверки удаления.',
      });
      const theirs = await database.customerReviews.upsert({
        accountId: other.identity.accountId,
        productVariantId: variant.variant.productVariantId,
        stars: 3,
        text: 'Другой отзыв остаётся у другого пользователя.',
      });
      assert.equal(mine.kind, 'CREATED');
      assert.equal(theirs.kind, 'CREATED');
      await pool.query(
        "INSERT INTO wtm_mascara_preference_versions(account_id,profile_version,mode,waterproof_preference,removal_preference,sensitive_eyes,contact_lenses) VALUES ($1,1,'UNKNOWN_GOALS','NO_PREFERENCE','NO_PREFERENCE',false,false)",
        [accountId],
      );
      await pool.query(
        'INSERT INTO wtm_account_recovery_codes(account_id,code_hash) VALUES ($1,$2)',
        [accountId, createHash('sha256').update(randomUUID()).digest('hex')],
      );
      const moderationId = randomUUID();
      await pool.query(
        "INSERT INTO wtm_catalog_promotion_cases(id,gtin14,resolution_kind,moderated_by_account_id) VALUES ($1,$2,'ADMIN',$3)",
        [moderationId, String(Date.now()).padStart(14, '0'), accountId],
      );
      const payload = { password, confirmation: 'DELETE' };
      const csrf = await app.inject({
        method: 'DELETE',
        url: '/api/v1/accounts/current',
        headers: {
          cookie: `__Host-wtm_session=${registered.token}`,
          'x-forwarded-for': '192.0.2.90',
        },
        payload,
      });
      assert.equal(csrf.statusCode, 403);
      assert.match(String(csrf.headers['cache-control']), /no-store/);
      const invalid = await app.inject({
        method: 'DELETE',
        url: '/api/v1/accounts/current',
        headers: {
          origin,
          cookie: `__Host-wtm_session=${registered.token}`,
          'x-forwarded-for': '192.0.2.91',
        },
        payload: { password, confirmation: 'YES' },
      });
      assert.equal(invalid.statusCode, 400);
      const erased = await app.inject({
        method: 'DELETE',
        url: '/api/v1/accounts/current',
        headers: {
          origin,
          cookie: `__Host-wtm_session=${registered.token}`,
          'x-forwarded-for': '192.0.2.92',
        },
        payload,
      });
      assert.equal(erased.statusCode, 204, erased.body);
      assert.match(String(erased.headers['cache-control']), /no-store/);
      assert.match(
        String(erased.headers['set-cookie']),
        /Max-Age=0|Expires=Thu, 01 Jan 1970/i,
      );
      assert.equal(await identity.current(registered.token), null);
      assert.equal(await identity.current(secondSession.token), null);
      await assert.rejects(
        identity.login({ email, password }, null),
        (error: unknown) =>
          error instanceof AppError && error.statusCode === 401,
      );
      const deleted = (
        await pool.query(
          'SELECT status,email_normalized,password_hash FROM wtm_accounts WHERE id=$1',
          [accountId],
        )
      ).rows[0];
      assert.equal(deleted.status, 'DELETED');
      assert.match(
        deleted.email_normalized,
        new RegExp(`^${accountId}\\.[a-f0-9-]+@deleted\\.invalid$`),
      );
      assert.equal(deleted.password_hash, 'deleted');
      for (const table of [
        'wtm_mascara_preference_versions',
        'wtm_customer_reviews',
        'wtm_account_recovery_codes',
        'wtm_identity_sessions',
      ]) {
        assert.equal(
          (
            await pool.query(
              `SELECT count(*)::integer AS n FROM ${table} WHERE account_id=$1`,
              [accountId],
            )
          ).rows[0].n,
          0,
          table,
        );
      }
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::integer AS n FROM wtm_guests WHERE claimed_by_account_id=$1',
            [accountId],
          )
        ).rows[0].n,
        0,
      );
      for (const data of [ownerData, guestData]) {
        assert.equal(
          await database.privateProducts.findOwned(
            data.snapshot.snapshotId,
            registered.identity,
          ),
          null,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::integer AS n FROM wtm_media_assets WHERE id=$1',
              [data.assetId],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::integer AS n FROM wtm_media_recovery_jobs WHERE operation_kind='DELETE_ASSET' AND resource_id=$1",
              [data.assetId],
            )
          ).rows[0].n,
          1,
        );
      }
      assert.ok(
        await database.privateProducts.findOwned(
          otherData.snapshot.snapshotId,
          other.identity,
        ),
      );
      assert.ok(
        await database.customerReviews.findOwned(
          other.identity.accountId,
          variant.variant.productVariantId,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT status FROM wtm_product_variants WHERE id=$1',
            [variant.variant.productVariantId],
          )
        ).rows[0].status,
        'PUBLISHED',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT moderated_by_account_id FROM wtm_catalog_promotion_cases WHERE id=$1',
            [moderationId],
          )
        ).rows[0].moderated_by_account_id,
        accountId,
      );
      await assert.rejects(
        database.media.createCollection(registered.identity),
        { code: '23503' },
      );
      const fresh = await identity.register({ email, password }, null);
      assert.equal(fresh.identity.kind, 'ACCOUNT');
      if (fresh.identity.kind === 'ACCOUNT')
        assert.notEqual(fresh.identity.accountId, accountId);
    } finally {
      await app.close();
      await database.close();
      await pool.end();
    }
  },
);
