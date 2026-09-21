import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicCustomerReview } from '../src/customer-review.js';
import { summarizeCustomerReviewMentions } from '../src/customer-review-mentions.js';

const asOf = new Date('2026-09-20T12:00:00.000Z');
function review(number: number, text: string): PublicCustomerReview {
  return {
    reviewId: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    stars: 3,
    text,
    verifiedPurchase: false,
    createdAt: asOf,
  };
}

test('review mentions require at least three unique visible reviews and dated evidence', () => {
  const first = review(1, 'Volume is mentioned here.');
  const second = review(2, 'No volume from this mascara.');
  assert.equal(summarizeCustomerReviewMentions([], asOf), null);
  assert.equal(summarizeCustomerReviewMentions([first, second], asOf), null);
  assert.equal(
    summarizeCustomerReviewMentions([first, first, second], asOf),
    null,
  );
  assert.equal(
    summarizeCustomerReviewMentions(
      [first, second, review(3, 'Third review')],
      null,
    ),
    null,
  );
});

test('fixed RU/EN words count each review once per topic including negative mentions', () => {
  const sample = [
    review(
      1,
      'Объём, ОБЪЁМ; длина. Без комочков, не осыпается. Смывается легко. Не водостойкая.',
    ),
    review(
      2,
      'No volume or length. No clumps or flaking. Removal is easy; not waterproof.',
    ),
    review(3, 'Volume volume volumizing: no sentiment inferred.'),
  ];
  const result = summarizeCustomerReviewMentions(sample, asOf);
  assert.ok(result);
  assert.equal(result.source, 'WTM');
  assert.equal(result.sampleSize, 3);
  assert.equal(result.asOf, asOf);
  assert.deepEqual(
    result.topics.map(({ topic, matchedReviewCount }) => ({
      topic,
      matchedReviewCount,
    })),
    [
      { topic: 'VOLUME', matchedReviewCount: 3 },
      { topic: 'LENGTH', matchedReviewCount: 2 },
      { topic: 'CLUMPING', matchedReviewCount: 2 },
      { topic: 'FLAKING', matchedReviewCount: 2 },
      { topic: 'REMOVAL', matchedReviewCount: 2 },
      { topic: 'WATERPROOF', matchedReviewCount: 2 },
    ],
  );
  for (const topic of result.topics) {
    assert.equal(topic.reviewIds.length, topic.matchedReviewCount);
    assert.equal(new Set(topic.reviewIds).size, topic.reviewIds.length);
    assert.ok(
      topic.reviewIds.every((id) =>
        sample.some((item) => item.reviewId === id),
      ),
    );
  }
  assert.equal('ratingValue' in result, false);
  assert.equal('sentiment' in result, false);
});

test('mentions use only the first twenty displayed reviews without changing their order or content', () => {
  const sample = Array.from({ length: 21 }, (_, index) =>
    review(
      index + 1,
      index === 20 ? 'Waterproof mascara.' : 'Volume mentioned.',
    ),
  );
  const before = structuredClone(sample);
  const result = summarizeCustomerReviewMentions(sample, asOf);
  assert.ok(result);
  assert.equal(result.sampleSize, 20);
  assert.deepEqual(result.topics, [
    {
      topic: 'VOLUME',
      matchedReviewCount: 20,
      reviewIds: sample.slice(0, 20).map((item) => item.reviewId),
    },
  ]);
  assert.deepEqual(sample, before);
});

test('unknown wording and word substrings do not invent topics', () => {
  const sample = [
    review(1, 'Volumetric lengthwise waterproofing.'),
    review(2, 'Любимая тушь, другая формулировка.'),
    review(3, 'Nothing from the fixed vocabulary.'),
  ];
  assert.equal(summarizeCustomerReviewMentions(sample, asOf), null);
});
