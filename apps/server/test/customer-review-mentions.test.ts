import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from 'typebox/value';
import { CustomerReviewSummaryResponseSchema } from '@wtm/contracts';
import type {
  CustomerReviewRepository,
  CustomerReviewSummary,
} from '@wtm/domain';
import { buildApp } from '../src/app.js';
import { createCustomerReviewService } from '../src/customer-reviews/service.js';
import { registerCustomerReviewRoutes } from '../src/routes/customer-reviews.js';

const variant = '00000000-0000-4000-8000-000000000001';
const asOf = new Date('2026-09-20T12:00:00.000Z');
const summary: CustomerReviewSummary = {
  source: 'WTM',
  sourceQuality: 'LOW',
  verifiedPurchase: false,
  ratingValue: 3.5,
  reviewCount: 45,
  asOf,
  reviews: Array.from({ length: 3 }, (_, index) => ({
    reviewId: `10000000-0000-4000-8000-00000000000${index + 1}`,
    stars: 3,
    text:
      index === 0
        ? 'No volume or volume improvement from this mascara.'
        : 'My personal experience with this exact mascara.',
    verifiedPurchase: false as const,
    createdAt: asOf,
  })),
};

test('public review mentions serialize only the displayed exact-variant sample; rating remains unchanged', async () => {
  const service = createCustomerReviewService({
    identity: {
      async current() {
        throw new Error('Public summary must not inspect identity');
      },
    },
    repository: {
      async summary(id: string, limit?: number) {
        assert.equal(id, variant);
        assert.equal(limit, 3);
        return summary;
      },
    } as CustomerReviewRepository,
  });
  const app = await buildApp();
  await registerCustomerReviewRoutes(app, {
    service,
    publicOrigin: 'https://whatthemake.test',
    cookieName: 'wtm_session',
  });
  try {
    const response = await app.inject({
      url: `/api/v1/products/${variant}/reviews?limit=3`,
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.ok(Value.Check(CustomerReviewSummaryResponseSchema, payload));
    assert.equal(payload.summary.ratingValue, 3.5);
    assert.equal(payload.summary.reviewCount, 45);
    assert.deepEqual(payload.summary.mentions, {
      source: 'WTM',
      sampleSize: 3,
      asOf: asOf.toISOString(),
      topics: [
        {
          topic: 'VOLUME',
          matchedReviewCount: 1,
          reviewIds: [summary.reviews[0]!.reviewId],
        },
      ],
    });
    assert.ok(
      payload.summary.mentions.topics[0].reviewIds.every((id: string) =>
        payload.summary.reviews.some(
          (review: { reviewId: string }) => review.reviewId === id,
        ),
      ),
    );
  } finally {
    await app.close();
  }
});

test('summary omits optional mentions when the shown sample is too small or has no matching words', async () => {
  for (const reviews of [
    summary.reviews.slice(0, 2),
    summary.reviews.map((review) => ({
      ...review,
      text: 'No matching terms in this personal experience.',
    })),
  ]) {
    const service = createCustomerReviewService({
      identity: {
        async current() {
          return null;
        },
      },
      repository: {
        async summary() {
          return { ...summary, reviews };
        },
      } as CustomerReviewRepository,
    });
    const result = await service.summary(variant);
    assert.equal(Object.hasOwn(result.summary, 'mentions'), false);
    assert.ok(Value.Check(CustomerReviewSummaryResponseSchema, result));
  }
});
