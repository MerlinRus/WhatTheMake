import type { PublicCustomerReview } from './customer-review.js';

export type CustomerReviewTopic =
  'VOLUME' | 'LENGTH' | 'CLUMPING' | 'FLAKING' | 'REMOVAL' | 'WATERPROOF';

export interface CustomerReviewMentions {
  source: 'WTM';
  sampleSize: number;
  asOf: Date;
  topics: Array<{
    topic: CustomerReviewTopic;
    matchedReviewCount: number;
    reviewIds: string[];
  }>;
}

// A deliberately small, fixed vocabulary: negation and sentiment are not inferred.
// These counts describe words in the visible sample, never product performance.
const vocabulary: ReadonlyArray<
  readonly [CustomerReviewTopic, readonly string[]]
> = [
  [
    'VOLUME',
    [
      'volume',
      'volumizing',
      'объем',
      'объема',
      'объемом',
      'объемный',
      'объемная',
    ],
  ],
  [
    'LENGTH',
    [
      'length',
      'lengthening',
      'длина',
      'длины',
      'длину',
      'удлинение',
      'удлиняет',
      'удлиняющая',
    ],
  ],
  [
    'CLUMPING',
    [
      'clump',
      'clumps',
      'clumping',
      'комок',
      'комки',
      'комков',
      'комочки',
      'комочков',
      'комочками',
      'склеивает',
      'склеивание',
    ],
  ],
  [
    'FLAKING',
    [
      'flake',
      'flakes',
      'flaking',
      'осыпается',
      'осыпалась',
      'осыпание',
      'осыпания',
      'осыпаний',
    ],
  ],
  [
    'REMOVAL',
    [
      'removal',
      'remove',
      'removing',
      'демакияж',
      'демакияжа',
      'смывается',
      'смывать',
      'смывание',
      'смывания',
    ],
  ],
  [
    'WATERPROOF',
    [
      'waterproof',
      'водостойкость',
      'водостойкости',
      'водостойкая',
      'водостойкую',
      'водостойкий',
      'водостойкой',
    ],
  ],
];

/** Only pass the approved, exact-variant reviews already selected for public display. */
export function summarizeCustomerReviewMentions(
  reviews: readonly PublicCustomerReview[],
  asOf: Date | null,
): CustomerReviewMentions | null {
  const seen = new Set<string>();
  const sample = reviews.slice(0, 20).filter((review) => {
    if (seen.has(review.reviewId)) return false;
    seen.add(review.reviewId);
    return true;
  });
  if (sample.length < 3 || asOf === null) return null;
  const tokens = sample.map((review) => ({
    reviewId: review.reviewId,
    words: new Set(
      review.text
        .normalize('NFKC')
        .toLowerCase()
        .replaceAll('ё', 'е')
        .split(/[^\p{L}]+/u),
    ),
  }));
  const topics = vocabulary.flatMap(([topic, words]) => {
    const reviewIds = tokens
      .filter((review) => words.some((word) => review.words.has(word)))
      .map((review) => review.reviewId);
    return reviewIds.length === 0
      ? []
      : [{ topic, matchedReviewCount: reviewIds.length, reviewIds }];
  });
  return topics.length === 0
    ? null
    : { source: 'WTM', sampleSize: sample.length, asOf, topics };
}
