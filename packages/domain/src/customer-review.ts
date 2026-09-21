export type CustomerReviewStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'DELETED';

export interface CustomerReview {
  reviewId: string;
  productVariantId: string;
  revisionNumber: number;
  stars: number;
  text: string;
  status: CustomerReviewStatus;
  duplicateText: boolean;
  verifiedPurchase: false;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicCustomerReview {
  reviewId: string;
  stars: number;
  text: string;
  verifiedPurchase: false;
  createdAt: Date;
}

export interface CustomerReviewSummary {
  source: 'WTM';
  sourceQuality: 'LOW';
  verifiedPurchase: false;
  ratingValue: number | null;
  reviewCount: number;
  asOf: Date | null;
  reviews: PublicCustomerReview[];
}

export interface UpsertCustomerReviewInput {
  accountId: string;
  productVariantId: string;
  stars: number;
  text: string;
}

export type UpsertCustomerReviewResult =
  | { kind: 'CREATED' | 'UPDATED' | 'UNCHANGED'; review: CustomerReview }
  | { kind: 'ACCOUNT_NOT_FOUND' }
  | { kind: 'VARIANT_NOT_FOUND' }
  | { kind: 'INVALID_INPUT' };

export interface CustomerReviewRepository {
  /** Trusted operator-only queue. Current pending revisions, oldest first; at most 50. */
  listPendingForModeration(
    limit?: number,
  ): Promise<Array<{ review: CustomerReview; authorPseudonym: string }>>;
  /** Trusted operator-only read, never exposed by consumer routes. */
  findForModeration(
    reviewId: string,
  ): Promise<{ review: CustomerReview; authorPseudonym: string } | null>;
  upsert(input: UpsertCustomerReviewInput): Promise<UpsertCustomerReviewResult>;
  findOwned(
    accountId: string,
    productVariantId: string,
  ): Promise<CustomerReview | null>;
  deleteOwned(
    accountId: string,
    productVariantId: string,
  ): Promise<'DELETED' | 'NOT_FOUND'>;
  /** Trusted operator path only. Never expose directly as a public endpoint. */
  moderate(input: {
    reviewId: string;
    revisionNumber: number;
    decision: 'APPROVED' | 'REJECTED';
    actorLabel: string;
    reason: string;
  }): Promise<
    | 'MODERATED'
    | 'NOT_FOUND'
    | 'STALE_REVISION'
    | 'DUPLICATE_TEXT'
    | 'INVALID_INPUT'
  >;
  summary(
    productVariantId: string,
    limit?: number,
  ): Promise<CustomerReviewSummary>;
}

export function normalizeCustomerReviewText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}
