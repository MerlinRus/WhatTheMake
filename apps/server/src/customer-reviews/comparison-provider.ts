import type {
  CustomerReviewRepository,
  ComparisonReviewSignal,
} from '@wtm/domain';
import type { ComparisonReviewSignalProvider } from '../comparison/service.js';

/** Only moderated, exact-variant WTM data; never substitute missing reviews. */
export function createCustomerReviewComparisonProvider(
  repository: Pick<CustomerReviewRepository, 'summary'>,
): ComparisonReviewSignalProvider {
  return {
    async findByProductVariantIds(ids) {
      const result = new Map<string, ComparisonReviewSignal>();
      for (const id of new Set(ids.slice(0, 3))) {
        const summary = await repository.summary(id, 1);
        if (
          summary.ratingValue !== null &&
          summary.reviewCount > 0 &&
          summary.asOf
        ) {
          result.set(id, {
            ratingValue: summary.ratingValue,
            reviewCount: summary.reviewCount,
            asOf: summary.asOf,
            sourceQuality: summary.sourceQuality,
          });
        }
      }
      return result;
    },
  };
}
