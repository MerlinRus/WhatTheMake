import type {
  CustomerReviewInput,
  CustomerReviewOwnResponse,
  CustomerReviewWriteResponse,
  CustomerReviewDeleteResponse,
  CustomerReviewSummaryResponse,
  CustomerReview as ContractReview,
} from '@wtm/contracts';
import type { CustomerReview, CustomerReviewRepository } from '@wtm/domain';
import { summarizeCustomerReviewMentions } from '@wtm/domain';
import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';

export interface CustomerReviewService {
  summary(
    productVariantId: string,
    limit?: number,
  ): Promise<CustomerReviewSummaryResponse>;
  own(
    token: string | null,
    productVariantId: string,
  ): Promise<CustomerReviewOwnResponse>;
  put(
    token: string | null,
    productVariantId: string,
    input: CustomerReviewInput,
  ): Promise<CustomerReviewWriteResponse>;
  delete(
    token: string | null,
    productVariantId: string,
    expectedAccountId?: string,
  ): Promise<CustomerReviewDeleteResponse>;
}
function contract(review: CustomerReview): ContractReview {
  return {
    ...review,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}
export function createCustomerReviewService(options: {
  identity: Pick<IdentityService, 'current'>;
  repository: CustomerReviewRepository;
}): CustomerReviewService {
  async function account(
    token: string | null,
    expectedAccountId?: string,
  ): Promise<string> {
    const identity = await options.identity.current(token);
    if (!identity)
      throw new AppError({
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    if (identity.kind !== 'ACCOUNT')
      throw new AppError({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Account required for customer reviews',
      });
    if (
      expectedAccountId !== undefined &&
      expectedAccountId !== identity.accountId
    )
      throw new AppError({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Account session changed',
      });
    return identity.accountId;
  }
  return {
    async summary(productVariantId, limit) {
      const summary = await options.repository.summary(productVariantId, limit);
      const mentions = summarizeCustomerReviewMentions(
        summary.reviews,
        summary.asOf,
      );
      return {
        summary: {
          ...summary,
          asOf: summary.asOf?.toISOString() ?? null,
          ...(mentions
            ? { mentions: { ...mentions, asOf: mentions.asOf.toISOString() } }
            : {}),
          reviews: summary.reviews.map((review) => ({
            ...review,
            createdAt: review.createdAt.toISOString(),
          })),
        },
      };
    },
    async own(token, productVariantId) {
      const review = await options.repository.findOwned(
        await account(token),
        productVariantId,
      );
      return { review: review ? contract(review) : null };
    },
    async put(token, productVariantId, input) {
      const result = await options.repository.upsert({
        stars: input.stars,
        text: input.text,
        accountId: await account(token, input.expectedAccountId),
        productVariantId,
      });
      if (result.kind === 'INVALID_INPUT')
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message:
            'Review must contain 20–4000 characters and a whole rating from 1 to 5',
        });
      if (result.kind === 'ACCOUNT_NOT_FOUND')
        throw new AppError({
          statusCode: 401,
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
        });
      if (result.kind === 'VARIANT_NOT_FOUND')
        throw new AppError({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Published product variant not found',
        });
      return { resultKind: result.kind, review: contract(result.review) };
    },
    async delete(token, productVariantId, expectedAccountId) {
      const result = await options.repository.deleteOwned(
        await account(token, expectedAccountId),
        productVariantId,
      );
      if (result === 'NOT_FOUND')
        throw new AppError({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Customer review not found',
        });
      return { deleted: true };
    },
  };
}
