import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomerReview, CustomerReviewRepository } from '@wtm/domain';
import { buildApp } from '../src/app.js';
import { createCustomerReviewService } from '../src/customer-reviews/service.js';
import { registerCustomerReviewRoutes } from '../src/routes/customer-reviews.js';
import { parseReviewModerationCommand } from '../src/cli/moderate-customer-review.js';
import { createCustomerReviewComparisonProvider } from '../src/customer-reviews/comparison-provider.js';

test('comparison reviews preserve exact variant, weak provenance and missing data', async () => {
  const queried: string[] = [];
  const observedAt = new Date('2026-09-20T00:00:00Z');
  const provider = createCustomerReviewComparisonProvider({
    async summary(id, limit) {
      queried.push(id);
      assert.equal(limit, 1);
      return {
        source: 'WTM',
        sourceQuality: 'LOW',
        verifiedPurchase: false,
        ratingValue: id === 'with-reviews' ? 4.2 : null,
        reviewCount: id === 'with-reviews' ? 12 : 0,
        asOf: id === 'with-reviews' ? observedAt : null,
        reviews: [],
      };
    },
  });
  const result = await provider.findByProductVariantIds([
    'with-reviews',
    'empty',
    'with-reviews',
  ]);
  assert.deepEqual(queried, ['with-reviews', 'empty']);
  assert.equal(result.size, 1);
  assert.deepEqual(result.get('with-reviews'), {
    ratingValue: 4.2,
    reviewCount: 12,
    asOf: observedAt,
    sourceQuality: 'LOW',
  });
});

const accountToken = 'a'.repeat(43);
const guestToken = 'g'.repeat(43);
const accountId = '11111111-1111-4111-8111-111111111111';
const productVariantId = '22222222-2222-4222-8222-222222222222';
const reviewId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-09-20T00:00:00.000Z');
const input = {
  stars: 4,
  text: 'This is a personal experience with the exact mascara variant.',
};
const review: CustomerReview = {
  reviewId,
  productVariantId,
  revisionNumber: 1,
  ...input,
  status: 'PENDING',
  duplicateText: false,
  verifiedPurchase: false,
  createdAt: now,
  updatedAt: now,
};
const origin = 'https://whatthemake.test';
const headers = { origin, cookie: `wtm_session=${accountToken}` };
const ownUrl = `/api/v1/products/${productVariantId}/my-review`;

async function fixture() {
  let writes = 0;
  let deletes = 0;
  let currentAccountId = accountId;
  const repository: CustomerReviewRepository = {
    async listPendingForModeration() {
      throw new Error('Consumer API must not list pending moderation');
    },
    async findForModeration() {
      throw new Error('Consumer API must not inspect moderation');
    },
    async moderate() {
      throw new Error('Consumer API must not moderate');
    },
    async upsert(value) {
      assert.equal(value.accountId, accountId);
      assert.equal(value.productVariantId, productVariantId);
      writes += 1;
      return { kind: 'CREATED', review };
    },
    async findOwned(owner, variant) {
      assert.equal(owner, accountId);
      assert.equal(variant, productVariantId);
      return review;
    },
    async deleteOwned(owner, variant) {
      assert.equal(owner, accountId);
      assert.equal(variant, productVariantId);
      deletes += 1;
      return 'DELETED';
    },
    async summary(variant, limit) {
      assert.equal(variant, productVariantId);
      assert.ok(limit === undefined || limit === 5);
      return {
        source: 'WTM',
        sourceQuality: 'LOW',
        verifiedPurchase: false,
        ratingValue: null,
        reviewCount: 0,
        asOf: null,
        reviews: [],
      };
    },
  };
  const service = createCustomerReviewService({
    identity: {
      async current(token) {
        if (token === accountToken)
          return {
            kind: 'ACCOUNT',
            accountId: currentAccountId,
            email: 'private@example.test',
            createdAt: now,
          };
        if (token === guestToken)
          return { kind: 'GUEST', guestId: accountId, createdAt: now };
        return null;
      },
    },
    repository,
  });
  const app = await buildApp();
  await registerCustomerReviewRoutes(app, {
    service,
    publicOrigin: origin,
    cookieName: 'wtm_session',
  });
  return {
    app,
    writes: () => writes,
    deletes: () => deletes,
    changeAccount: (value: string) => {
      currentAccountId = value;
    },
  };
}

test('review mutation account preconditions reject cookie changes after preflight without repository writes', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject({ url: ownUrl, headers })).statusCode,
      200,
    );
    f.changeAccount('44444444-4444-4444-8444-444444444444');
    for (const method of ['PUT', 'DELETE'] as const) {
      const stale = await f.app.inject({
        method,
        url: ownUrl,
        headers,
        payload:
          method === 'PUT'
            ? { ...input, expectedAccountId: accountId }
            : { expectedAccountId: accountId },
      });
      assert.equal(stale.statusCode, 403, stale.body);
      assert.equal(stale.headers['cache-control'], 'private, no-store');
      const malformed = await f.app.inject({
        method,
        url: ownUrl,
        headers,
        payload:
          method === 'PUT'
            ? { ...input, expectedAccountId: 'invalid' }
            : { expectedAccountId: 'invalid' },
      });
      assert.equal(malformed.statusCode, 400, malformed.body);
    }
    assert.equal(f.writes(), 0);
    assert.equal(f.deletes(), 0);
    f.changeAccount(accountId);
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: ownUrl,
          headers,
          payload: { ...input, expectedAccountId: accountId },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'DELETE',
          url: ownUrl,
          headers,
          payload: { expectedAccountId: accountId },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.writes(), 1);
    assert.equal(f.deletes(), 1);
  } finally {
    await f.app.close();
  }
});

test('customer review public summary uses no-data and unverified provenance without authentication', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      url: `/api/v1/products/${productVariantId}/reviews?limit=5`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.json().summary, {
      source: 'WTM',
      sourceQuality: 'LOW',
      verifiedPurchase: false,
      ratingValue: null,
      reviewCount: 0,
      asOf: null,
      reviews: [],
    });
    assert.equal(
      (
        await f.app.inject({
          url: `/api/v1/products/${productVariantId}/reviews?limit=21`,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/v1/products/not-a-uuid/reviews' }))
        .statusCode,
      400,
    );
  } finally {
    await f.app.close();
  }
});

test('customer review own endpoints require account and never leak email or approve submissions', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ url: ownUrl })).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          url: ownUrl,
          headers: { cookie: `wtm_session=${guestToken}` },
        })
      ).statusCode,
      403,
    );
    const own = await f.app.inject({ url: ownUrl, headers });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().review.createdAt, now.toISOString());
    assert.equal(own.headers['cache-control'], 'private, no-store');
    assert.ok(!own.body.includes('private@example.test'));
    const put = await f.app.inject({
      method: 'PUT',
      url: ownUrl,
      headers,
      payload: input,
    });
    assert.equal(put.statusCode, 201, put.body);
    assert.equal(put.json().review.status, 'PENDING');
    assert.equal(put.json().review.verifiedPurchase, false);
    assert.equal(f.writes(), 1);
    const removed = await f.app.inject({
      method: 'DELETE',
      url: ownUrl,
      headers,
      payload: {},
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.headers['cache-control'], 'private, no-store');
    assert.equal(f.deletes(), 1);
  } finally {
    await f.app.close();
  }
});

test('customer review writes reject foreign origins, guests, invalid bounds and ownership spoofing', async () => {
  const f = await fixture();
  try {
    const cases = [
      {
        headers: { ...headers, origin: 'https://foreign.test' },
        payload: input,
        status: 403,
      },
      { headers: { origin }, payload: input, status: 401 },
      {
        headers: { origin, cookie: `wtm_session=${guestToken}` },
        payload: input,
        status: 403,
      },
      { headers, payload: { ...input, stars: 0 }, status: 400 },
      { headers, payload: { ...input, stars: 1.5 }, status: 400 },
      { headers, payload: { ...input, stars: 6 }, status: 400 },
      { headers, payload: { ...input, text: 'short' }, status: 400 },
      { headers, payload: { ...input, text: 'x'.repeat(4001) }, status: 400 },
      { headers, payload: { ...input, accountId }, status: 400 },
    ];
    for (const [index, example] of cases.entries()) {
      const response = await f.app.inject({
        method: 'PUT',
        url: ownUrl,
        headers: example.headers,
        payload: example.payload,
        remoteAddress: `192.0.2.${index + 1}`,
      });
      assert.equal(response.statusCode, example.status, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    const nonJson = await f.app.inject({
      method: 'PUT',
      url: ownUrl,
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: JSON.stringify(input),
    });
    assert.equal(nonJson.statusCode, 415);
    const badDelete = await f.app.inject({
      method: 'DELETE',
      url: ownUrl,
      headers: { ...headers, origin: 'https://foreign.test' },
      payload: {},
    });
    assert.equal(badDelete.statusCode, 403);
    assert.equal(f.writes(), 0);
    assert.equal(f.deletes(), 0);
  } finally {
    await f.app.close();
  }
});

test('customer review PUT is limited to five attempts per hour', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await f.app.inject({
        method: 'PUT',
        url: ownUrl,
        headers,
        payload: input,
      });
      assert.equal(response.statusCode, index < 5 ? 201 : 429, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    assert.equal(f.writes(), 5);
  } finally {
    await f.app.close();
  }
});

test('review moderation command defaults to read-only and requires one explicit bounded decision', () => {
  const args = [
    '--review-id',
    reviewId,
    '--revision',
    '2',
    '--approve',
    '--actor',
    'operator-test',
    '--reason',
    'Read the submitted text',
  ];
  assert.deepEqual(parseReviewModerationCommand(args), {
    kind: 'MODERATE',
    apply: false,
    reviewId,
    revisionNumber: 2,
    decision: 'APPROVED',
    actorLabel: 'operator-test',
    reason: 'Read the submitted text',
  });
  const applied = parseReviewModerationCommand([...args, '--apply']);
  assert.equal(applied.kind === 'MODERATE' && applied.apply, true);
  for (const invalid of [
    [...args, '--reject'],
    [...args, '--apply', '--dry-run'],
    [...args, '--actor', 'again'],
    args.filter((value) => value !== '--approve'),
    ['--review-id', reviewId],
    args.map((value) => (value === '2' ? '0' : value)),
    args.map((value) => (value === reviewId ? 'not-a-uuid' : value)),
  ])
    assert.throws(() => parseReviewModerationCommand(invalid));
});

test('pending moderation queue is read-only and accepts only a bounded list limit', () => {
  assert.deepEqual(parseReviewModerationCommand(['--list-pending']), {
    kind: 'LIST_PENDING',
    limit: 20,
  });
  assert.deepEqual(
    parseReviewModerationCommand(['--list-pending', '--limit', '50']),
    { kind: 'LIST_PENDING', limit: 50 },
  );
  assert.deepEqual(
    parseReviewModerationCommand(['--limit', '1', '--list-pending']),
    { kind: 'LIST_PENDING', limit: 1 },
  );
  for (const invalid of [
    ['--list-pending', '--apply'],
    ['--list-pending', '--dry-run'],
    ['--list-pending', '--approve'],
    ['--list-pending', '--reject'],
    ['--list-pending', '--review-id', reviewId],
    ['--list-pending', '--list-pending'],
    ['--list-pending', '--limit'],
    ['--list-pending', '--limit', '0'],
    ['--list-pending', '--limit', '51'],
    ['--list-pending', '--limit', '-1'],
    ['--list-pending', '--limit', '1.5'],
    ['--list-pending', '--limit', '1', '--limit', '2'],
  ])
    assert.throws(() => parseReviewModerationCommand(invalid));
});
