import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareMascaras,
  type ComparisonBrief,
  type ReadyComparisonCandidate,
} from '../src/comparison.js';

const now = new Date('2026-08-31T12:00:00.000Z');
const quick: ComparisonBrief = {
  mode: 'UNKNOWN_GOALS',
  waterproof: 'NO_PREFERENCE',
  removal: 'NO_PREFERENCE',
  avoidedIngredients: [],
};

function candidate(
  productVariantId: string,
  slotIndex: number,
  overrides: Partial<ReadyComparisonCandidate> = {},
): ReadyComparisonCandidate {
  return {
    state: 'READY',
    slotIndex,
    gtin: slotIndex === 0 ? '4006381333931' : '5901234123457',
    productVariantId,
    isWaterproof: false,
    formulaText: 'AQUA, WAX',
    claimKinds: [],
    review: null,
    ...overrides,
  };
}

test('hard waterproof constraint outranks a stronger review', () => {
  const result = compareMascaras({
    candidates: [
      candidate('waterproof', 0, { isWaterproof: true }),
      candidate('reviewed', 1, {
        review: {
          ratingValue: 5,
          reviewCount: 1000,
          asOf: now,
          sourceQuality: 'HIGH',
        },
      }),
    ],
    brief: { ...quick, waterproof: 'REQUIRED' },
    now,
  });
  assert.equal(result.recommendation.kind, 'PREFERRED');
  assert.equal(
    result.recommendation.kind === 'PREFERRED' &&
      result.recommendation.productVariantId,
    'waterproof',
  );
});

test('personalized goal uses only explicit manufacturer claim kinds', () => {
  const result = compareMascaras({
    candidates: [
      candidate('volume', 0, { claimKinds: ['VOLUME'] }),
      candidate('plain', 1),
    ],
    brief: { ...quick, mode: 'PERSONALIZED', goals: ['VOLUME'] },
    now,
  });
  assert.equal(result.recommendation.kind, 'PREFERRED');
  assert.equal(
    result.recommendation.kind === 'PREFERRED' &&
      result.recommendation.productVariantId,
    'volume',
  );
});

test('strong fresh review evidence can decide unknown-goals mode', () => {
  const result = compareMascaras({
    candidates: [
      candidate('better', 0, {
        review: {
          ratingValue: 4.8,
          reviewCount: 500,
          asOf: now,
          sourceQuality: 'HIGH',
        },
      }),
      candidate('other', 1, {
        review: {
          ratingValue: 4.2,
          reviewCount: 400,
          asOf: now,
          sourceQuality: 'HIGH',
        },
      }),
    ],
    brief: quick,
    now,
  });
  assert.equal(result.recommendation.kind, 'PREFERRED');
  assert.equal(
    result.recommendation.kind === 'PREFERRED' &&
      result.recommendation.productVariantId,
    'better',
  );
  const reviews = result.criteria.find(
    (criterion) => criterion.kind === 'CUSTOMER_REVIEWS',
  );
  assert.equal(reviews?.observations[0]?.outcome, 'ADVANTAGE');
  assert.equal(reviews?.observations[1]?.outcome, 'DISADVANTAGE');
});

test('easy-removal preference uses only an explicit manufacturer claim', () => {
  const result = compareMascaras({
    candidates: [
      candidate('easy', 0, { claimKinds: ['EASY_REMOVAL'] }),
      candidate('plain', 1),
    ],
    brief: {
      ...quick,
      mode: 'PERSONALIZED',
      goals: ['VOLUME'],
      removal: 'EASY_REQUIRED',
    },
    now,
  });
  assert.equal(result.recommendation.kind, 'PREFERRED');
  assert.equal(
    result.recommendation.kind === 'PREFERRED' &&
      result.recommendation.productVariantId,
    'easy',
  );
});

test('missing reviews and external identity produce honest no-winner states', () => {
  const missingReviews = compareMascaras({
    candidates: [candidate('one', 0), candidate('two', 1)],
    brief: quick,
    now,
  });
  assert.deepEqual(missingReviews.recommendation, {
    kind: 'NO_CLEAR_WINNER',
    confidence: 'LOW',
    reasonCodes: ['REVIEW_DATA_UNAVAILABLE'],
  });

  const external = compareMascaras({
    candidates: [
      candidate('one', 0),
      {
        state: 'BLOCKED',
        slotIndex: 1,
        gtin: '5901234123457',
        reason: 'EXTERNAL_CANDIDATE',
      },
    ],
    brief: quick,
    now,
  });
  assert.equal(external.recommendation.kind, 'NO_CLEAR_WINNER');
  assert.ok(
    external.recommendation.reasonCodes.includes(
      'EXTERNAL_IDENTITY_UNCONFIRMED',
    ),
  );
});

test('same frozen input is deterministic', () => {
  const input = {
    candidates: [candidate('one', 0), candidate('two', 1)],
    brief: quick,
    now,
  } as const;
  assert.deepEqual(compareMascaras(input), compareMascaras(input));
});
