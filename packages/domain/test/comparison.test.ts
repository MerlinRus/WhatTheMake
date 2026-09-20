import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { InciDictionarySnapshot } from '../src/inci-canonicalization.js';

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

test('required easy removal remains uncertain when a competing claim is missing', () => {
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
  assert.equal(result.recommendation.kind, 'NO_CLEAR_WINNER');
  assert.ok(
    result.recommendation.reasonCodes.includes('HARD_CONSTRAINT_DATA_MISSING'),
  );
});

const dictionary = JSON.parse(
  readFileSync(
    new URL('../../../apps/server/seeds/inci/dictionary.json', import.meta.url),
    'utf8',
  ),
) as InciDictionarySnapshot;

test('no winner may violate a hard constraint even when every candidate fails', () => {
  for (const [candidates, constraint] of [
    [
      [candidate('one', 0, { claimKinds: ['LENGTH'] }), candidate('two', 1)],
      { waterproof: 'REQUIRED' },
    ],
    [
      [
        candidate('one', 0, { formulaText: 'Aqua, Parfum' }),
        candidate('two', 1, { formulaText: 'Aqua, Parfum, Alcohol' }),
      ],
      { avoidedIngredients: ['Parfum', 'Alcohol'] },
    ],
  ] as const) {
    const result = compareMascaras({
      candidates,
      brief: {
        ...quick,
        mode: 'PERSONALIZED',
        goals: ['LENGTH'],
        ...constraint,
      },
      dictionary,
      now,
    });
    assert.equal(result.recommendation.kind, 'NO_CLEAR_WINNER');
  }
});

test('two eligible tied slots cannot allow a third violating slot to win on claims', () => {
  const result = compareMascaras({
    candidates: [
      candidate('one', 0, { isWaterproof: true }),
      candidate('two', 1, { isWaterproof: true }),
      candidate('bad', 2, { claimKinds: ['LENGTH'] }),
    ],
    brief: {
      ...quick,
      mode: 'PERSONALIZED',
      goals: ['LENGTH'],
      waterproof: 'REQUIRED',
    },
    now,
  });
  assert.equal(result.recommendation.kind, 'NO_CLEAR_WINNER');
});

test('dictionary aliases and compound labels cannot hide an excluded ingredient', () => {
  const result = compareMascaras({
    candidates: [
      candidate('alias', 0, {
        formulaText: 'Aqua, Cera Alba/Beeswax',
        claimKinds: ['LENGTH'],
      }),
      candidate('plain', 1, { formulaText: 'Aqua, Beeswax' }),
    ],
    brief: {
      ...quick,
      mode: 'PERSONALIZED',
      goals: ['LENGTH'],
      avoidedIngredients: ['Beeswax'],
    },
    dictionary,
    now,
  });
  assert.equal(result.recommendation.kind, 'NO_CLEAR_WINNER');
  const hard = result.criteria.find((c) => c.kind === 'HARD_CONSTRAINTS');
  assert.ok(
    hard?.observations.every(
      (o) => o.outcome === 'DISADVANTAGE' || o.outcome === 'NO_DATA',
    ),
  );
});

test('absence requires a dictionary and fully resolved composition', () => {
  for (const dict of [null, dictionary]) {
    const result = compareMascaras({
      candidates: [
        candidate('unknown', 0, {
          formulaText: 'Aqua, Mysterious Ingredient',
          claimKinds: ['VOLUME'],
        }),
        candidate('other', 1, { formulaText: 'Aqua, Glycerin' }),
      ],
      brief: {
        ...quick,
        mode: 'PERSONALIZED',
        goals: ['VOLUME'],
        avoidedIngredients: ['Beeswax'],
      },
      dictionary: dict,
      now,
    });
    assert.equal(result.recommendation.kind, 'NO_CLEAR_WINNER');
    assert.ok(
      result.recommendation.reasonCodes.includes(
        'HARD_CONSTRAINT_DATA_MISSING',
      ),
    );
  }
});

test('resolved exclusion can prefer the variant without that ingredient', () => {
  const result = compareMascaras({
    candidates: [
      candidate('clear', 0, { formulaText: 'Aqua, Glycerin' }),
      candidate('wax', 1, { formulaText: 'Aqua, Beeswax' }),
    ],
    brief: { ...quick, avoidedIngredients: ['Beeswax'] },
    dictionary,
    now,
  });
  assert.equal(result.recommendation.kind, 'PREFERRED');
  if (result.recommendation.kind === 'PREFERRED')
    assert.equal(result.recommendation.productVariantId, 'clear');
});

test('every requested slot must be resolved before choosing a winner', () => {
  for (const reason of ['NOT_FOUND', 'INVALID_GTIN'] as const) {
    const result = compareMascaras({
      candidates: [
        candidate('one', 0, { claimKinds: ['LENGTH'] }),
        candidate('two', 1),
        { state: 'BLOCKED', slotIndex: 2, gtin: '9999999999994', reason },
      ],
      brief: { ...quick, mode: 'PERSONALIZED', goals: ['LENGTH'] },
      now,
    });
    assert.equal(result.recommendation.kind, 'NO_CLEAR_WINNER');
  }
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

test('reviews never select an ineligible third variant', () => {
  const review = (ratingValue: number) => ({
    ratingValue,
    reviewCount: 100,
    asOf: now,
    sourceQuality: 'HIGH' as const,
  });
  const result = compareMascaras({
    candidates: [
      candidate('eligible', 0, { isWaterproof: true, review: review(4.6) }),
      candidate('other', 1, { isWaterproof: true, review: review(4.0) }),
      candidate('ineligible', 2, { review: review(5.0) }),
    ],
    brief: { ...quick, waterproof: 'REQUIRED' },
    now,
  });
  assert.equal(result.recommendation.kind, 'PREFERRED');
  if (result.recommendation.kind === 'PREFERRED')
    assert.equal(result.recommendation.productVariantId, 'eligible');
});
