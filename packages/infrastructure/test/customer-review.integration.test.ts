import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import type { CatalogProvenanceInput } from '@wtm/domain';
import { createPostgresDatabase } from '../src/postgres.js';
import { createPostgresCustomerReviewRepository } from '../src/customer-review-repository.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  'pending moderation queue is bounded, ordered, current-revision only and read-only',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    // Connection-local tables keep this queue independent of other suites and existing reviews.
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const repository = createPostgresCustomerReviewRepository(pool);
    const reviewId = (number: number) =>
      `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    try {
      await pool.query(`
        CREATE TEMP TABLE wtm_accounts (id uuid PRIMARY KEY, status text, email text);
        CREATE TEMP TABLE wtm_customer_reviews (
          id uuid PRIMARY KEY, account_id uuid, variant_id uuid,
          current_revision_number integer, status text, duplicate_text boolean,
          created_at timestamptz, updated_at timestamptz
        );
        CREATE TEMP TABLE wtm_customer_review_revisions (
          review_id uuid, revision_number integer, stars integer, body text,
          normalized_sha256 text, created_at timestamptz,
          PRIMARY KEY (review_id, revision_number)
        );
        INSERT INTO wtm_accounts
          SELECT ('10000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
            CASE WHEN number = 59 THEN 'BLOCKED' ELSE 'ACTIVE' END,
            'private-account-email@example.test'
          FROM generate_series(1, 60) AS number;
        INSERT INTO wtm_customer_reviews
          SELECT ('00000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
            ('10000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
            '20000000-0000-4000-8000-000000000001'::uuid,
            CASE WHEN number = 3 THEN 2 ELSE 1 END,
            CASE number WHEN 56 THEN 'APPROVED' WHEN 57 THEN 'REJECTED' WHEN 58 THEN 'DELETED' ELSE 'PENDING' END,
            number = 2,
            '2026-01-01'::timestamptz,
            CASE WHEN number BETWEEN 56 AND 59 THEN '2020-01-01'::timestamptz
              ELSE '2026-01-01'::timestamptz + number * interval '1 second' END
          FROM generate_series(1, 60) AS number;
        INSERT INTO wtm_customer_review_revisions
          SELECT id, 1, 4, 'First version of a pending review fixture.', repeat('a', 64), created_at
          FROM wtm_customer_reviews;
        INSERT INTO wtm_customer_review_revisions
          SELECT id, 2, 2, 'Edited current version of a pending review fixture.', repeat('b', 64), updated_at
          FROM wtm_customer_reviews WHERE current_revision_number = 2;
      `);
      // Read-only prevents persistent writes; the before/after check also guards temporary fixtures.
      await pool.query('BEGIN READ ONLY');
      const before = await pool.query(
        'SELECT id, current_revision_number, status, updated_at FROM wtm_customer_reviews ORDER BY id',
      );
      const pending = await repository.listPendingForModeration();
      assert.equal(pending.length, 20);
      assert.deepEqual(
        pending.map((entry) => entry.review.reviewId),
        Array.from({ length: 20 }, (_, index) => reviewId(index + 1)),
      );
      assert.equal(pending[1]?.review.duplicateText, true);
      assert.equal(pending[2]?.review.revisionNumber, 2);
      assert.equal(pending[2]?.review.stars, 2);
      assert.equal(
        pending[2]?.review.text,
        'Edited current version of a pending review fixture.',
      );
      assert.ok(pending.every((entry) => entry.review.status === 'PENDING'));
      assert.ok(
        pending.every((entry) =>
          /^wtm-[a-f0-9]{16}$/.test(entry.authorPseudonym),
        ),
      );
      assert.equal(
        JSON.stringify(pending).includes('private-account-email'),
        false,
      );
      assert.equal(JSON.stringify(pending).includes('10000000-0000'), false);
      assert.equal((await repository.listPendingForModeration(500)).length, 50);
      assert.equal((await repository.listPendingForModeration(-1)).length, 1);
      assert.equal(
        (await repository.listPendingForModeration(Number.NaN)).length,
        20,
      );
      assert.equal(
        (await repository.listPendingForModeration(1.9))[0]?.review.reviewId,
        reviewId(1),
      );
      const after = await pool.query(
        'SELECT id, current_revision_number, status, updated_at FROM wtm_customer_reviews ORDER BY id',
      );
      assert.deepEqual(after.rows, before.rows);
      await pool.query('ROLLBACK');
    } finally {
      await pool.query('ROLLBACK').catch(() => {});
      await pool.end();
    }
  },
);

test(
  'WTM reviews enforce ownership, revision moderation, duplicate exclusion and account erasure',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 3,
      applicationName: 'wtm-customer-review-test',
    });
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 6 });
    const repository = createPostgresCustomerReviewRepository(pool);
    const provenance: CatalogProvenanceInput = {
      sourceKind: 'MANUFACTURER',
      sourceLabel: 'Review test fixture',
      sourceUri: 'https://example.test/mascara',
      sourceRecordId: randomUUID(),
      observedAt: new Date(),
      rightsStatus: 'ALLOWED',
    };
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const family = await database.catalog.createFamily(
        { category: 'MASCARA', brandName: 'Review Fixture', name: 'Mascara' },
        provenance,
      );
      const created = await database.catalog.createVariant(
        {
          productFamilyId: family.productFamilyId,
          name: 'Black',
          shadeName: null,
          netQuantityValue: null,
          netQuantityUnit: null,
          waterproof: false,
        },
        provenance,
      );
      assert.equal(created.kind, 'CREATED');
      if (created.kind !== 'CREATED')
        throw new Error('Missing fixture variant');
      const productVariantId = created.variant.productVariantId;
      const accounts = await Promise.all(
        Array.from({ length: 3 }, () =>
          database.identity.createAccount({
            email: `${randomUUID()}@example.test`,
            passwordHash: 'test-only',
            sessionTokenHash: createHash('sha256')
              .update(randomUUID())
              .digest('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ),
      );
      const first = accounts[0]!;
      const second = accounts[1]!;
      const third = accounts[2]!;
      const text =
        'Leaves clear separated lashes after one careful application.';
      const input = {
        accountId: first.accountId,
        productVariantId,
        stars: 5,
        text,
      };
      assert.deepEqual(await repository.upsert(input), {
        kind: 'VARIANT_NOT_FOUND',
      });
      await database.catalog.transitionFamilyStatus(
        family.productFamilyId,
        'PUBLISHED',
      );
      await database.catalog.transitionVariantStatus(
        productVariantId,
        'PUBLISHED',
      );
      assert.deepEqual(await repository.upsert({ ...input, stars: 0 }), {
        kind: 'INVALID_INPUT',
      });
      assert.deepEqual(
        await repository.upsert({ ...input, text: 'too short' }),
        { kind: 'INVALID_INPUT' },
      );
      assert.deepEqual(
        await repository.upsert({ ...input, text: '😀'.repeat(10) }),
        { kind: 'INVALID_INPUT' },
      );
      assert.deepEqual(
        await repository.upsert({ ...input, accountId: randomUUID() }),
        { kind: 'ACCOUNT_NOT_FOUND' },
      );
      const concurrent = await Promise.all([
        repository.upsert(input),
        repository.upsert(input),
      ]);
      assert.deepEqual(concurrent.map((result) => result.kind).sort(), [
        'CREATED',
        'UNCHANGED',
      ]);
      const saved = concurrent.find((result) => result.kind === 'CREATED');
      assert.ok(saved && 'review' in saved);
      const id = saved.review.reviewId;
      const preview = await repository.findForModeration(id);
      assert.equal(preview?.review.status, 'PENDING');
      assert.match(preview?.authorPseudonym ?? '', /^wtm-[a-f0-9]{16}$/);
      assert.equal(await repository.findForModeration(randomUUID()), null);
      assert.equal(saved.review.status, 'PENDING');
      assert.equal(saved.review.verifiedPurchase, false);
      assert.equal(
        await repository.findOwned(second.accountId, productVariantId),
        null,
      );
      assert.equal(
        await repository.deleteOwned(second.accountId, productVariantId),
        'NOT_FOUND',
      );
      assert.equal(
        (await repository.summary(productVariantId)).ratingValue,
        null,
      );
      const moderation = {
        reviewId: id,
        revisionNumber: 1,
        decision: 'APPROVED' as const,
        actorLabel: 'test-operator',
        reason: 'Reviewed fixture text',
      };
      assert.equal(await repository.moderate(moderation), 'MODERATED');
      let summary = await repository.summary(productVariantId);
      assert.equal(summary.reviewCount, 1);
      assert.equal(summary.ratingValue, 5);
      assert.equal(summary.sourceQuality, 'LOW');
      assert.equal(summary.verifiedPurchase, false);
      assert.ok(summary.asOf instanceof Date);
      assert.equal('accountId' in summary.reviews[0]!, false);

      const edit = await repository.upsert({
        ...input,
        text: 'An edited experience that needs independent moderation again.',
        stars: 2,
      });
      assert.ok('review' in edit);
      assert.equal(edit.review.revisionNumber, 2);
      assert.equal(edit.review.status, 'PENDING');
      assert.equal((await repository.summary(productVariantId)).reviewCount, 0);
      assert.equal(await repository.moderate(moderation), 'STALE_REVISION');
      assert.equal(
        await repository.moderate({
          ...moderation,
          revisionNumber: 2,
          decision: 'REJECTED',
        }),
        'MODERATED',
      );
      assert.equal((await repository.summary(productVariantId)).reviewCount, 0);
      const history = await pool.query(
        'SELECT body FROM wtm_customer_review_revisions WHERE review_id = $1 ORDER BY revision_number',
        [id],
      );
      assert.deepEqual(
        history.rows.map((row) => row.body),
        [text, 'An edited experience that needs independent moderation again.'],
      );
      await assert.rejects(
        pool.query(
          "UPDATE wtm_customer_review_revisions SET body = 'A tampered previous review body.' WHERE review_id = $1 AND revision_number = 1",
          [id],
        ),
        { code: '23514' },
      );
      await assert.rejects(
        pool.query(
          "UPDATE wtm_customer_review_audit SET reason = 'Tampered' WHERE review_id = $1",
          [id],
        ),
        { code: '23514' },
      );

      const original = await repository.upsert(input);
      assert.ok('review' in original);
      const copy = await repository.upsert({
        ...input,
        accountId: second.accountId,
        text: `  ${text.toUpperCase().replaceAll(' ', '  ')}  `,
        stars: 1,
      });
      assert.ok('review' in copy);
      assert.equal(copy.review.duplicateText, true);
      assert.equal(copy.review.status, 'PENDING');
      assert.equal(
        await repository.moderate({
          ...moderation,
          reviewId: copy.review.reviewId,
        }),
        'DUPLICATE_TEXT',
      );
      assert.equal(
        await repository.moderate({
          ...moderation,
          revisionNumber: original.review.revisionNumber,
        }),
        'MODERATED',
      );
      assert.equal(
        await repository.moderate({
          ...moderation,
          reviewId: copy.review.reviewId,
        }),
        'DUPLICATE_TEXT',
      );
      assert.equal((await repository.summary(productVariantId)).reviewCount, 1);
      assert.equal(
        await repository.moderate({
          ...moderation,
          reviewId: copy.review.reviewId,
          decision: 'REJECTED',
        }),
        'MODERATED',
      );
      const independent = await repository.upsert({
        ...input,
        accountId: third.accountId,
        stars: 3,
        text: 'The brush gives a subtle finish after two coats on my lashes.',
      });
      assert.ok('review' in independent);
      assert.equal(
        await repository.moderate({
          ...moderation,
          reviewId: independent.review.reviewId,
        }),
        'MODERATED',
      );
      summary = await repository.summary(productVariantId, 1);
      assert.equal(summary.reviewCount, 2);
      assert.equal(summary.ratingValue, 4);
      assert.equal(summary.reviews.length, 1);

      const race = await Promise.all([
        repository.upsert({
          ...input,
          text: 'An updated experience under concurrent moderation and editing.',
          stars: 4,
        }),
        repository.moderate({
          ...moderation,
          revisionNumber: original.review.revisionNumber,
        }),
      ]);
      assert.equal(race[0].kind, 'UPDATED');
      assert.equal(
        (await repository.findOwned(first.accountId, productVariantId))?.status,
        'PENDING',
      );
      assert.equal((await repository.summary(productVariantId)).reviewCount, 1);
      assert.equal(
        await repository.deleteOwned(third.accountId, productVariantId),
        'DELETED',
      );
      assert.equal(
        await repository.deleteOwned(third.accountId, productVariantId),
        'DELETED',
      );
      assert.equal((await repository.summary(productVariantId)).reviewCount, 0);
      assert.equal(
        await repository.moderate({
          ...moderation,
          reviewId: independent.review.reviewId,
        }),
        'NOT_FOUND',
      );
      await pool.query(
        "UPDATE wtm_accounts SET status = 'BLOCKED' WHERE id = $1",
        [first.accountId],
      );
      assert.equal(
        await repository.findOwned(first.accountId, productVariantId),
        null,
      );
      assert.deepEqual(await repository.upsert(input), {
        kind: 'ACCOUNT_NOT_FOUND',
      });
      await pool.query('DELETE FROM wtm_accounts WHERE id = $1', [
        first.accountId,
      ]);
      for (const table of [
        'wtm_customer_reviews',
        'wtm_customer_review_revisions',
        'wtm_customer_review_audit',
      ]) {
        const column = table === 'wtm_customer_reviews' ? 'id' : 'review_id';
        assert.equal(
          (
            await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [
              id,
            ])
          ).rowCount,
          0,
        );
      }
    } finally {
      await Promise.all([database.close(), pool.end()]);
    }
  },
);
