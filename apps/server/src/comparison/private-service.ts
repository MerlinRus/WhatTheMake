import type {
  PrivateComparisonInput,
  PrivateComparisonResponse,
  PrivateComparisonSlot,
} from '@wtm/contracts';
import {
  compareMascaras,
  hasUnsupportedMascaraCategory,
  normalizeGtin,
  type ComparisonCandidate,
  type InciDictionaryRepository,
  type PrivateProductRepository,
  type PrivateProductSnapshotId,
} from '@wtm/domain';

import type { CatalogLookupService } from '../catalog/service.js';
import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import { privateProductSnapshotContract } from '../private-products/service.js';
import {
  explanations,
  publicReview,
  type ComparisonReviewSignalProvider,
} from './service.js';

export interface PrivateComparisonService {
  preview(
    token: string | null,
    input: PrivateComparisonInput,
  ): Promise<PrivateComparisonResponse>;
}

export function createPrivateComparisonService(options: {
  identity: Pick<IdentityService, 'current'>;
  privateProducts: Pick<PrivateProductRepository, 'findOwned'>;
  catalog: CatalogLookupService;
  reviews: ComparisonReviewSignalProvider;
  dictionary: Pick<InciDictionaryRepository, 'findPublishedSnapshot'>;
  now?: () => Date;
}): PrivateComparisonService {
  return {
    async preview(token, input) {
      const owner = await options.identity.current(token);
      if (!owner)
        throw new AppError({
          statusCode: 401,
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
        });
      const slots: PrivateComparisonSlot[] = await Promise.all(
        input.slots.map(
          async (slot, slotIndex): Promise<PrivateComparisonSlot> => {
            if (slot.kind === 'PRIVATE') {
              const snapshot = await options.privateProducts.findOwned(
                slot.snapshotId as PrivateProductSnapshotId,
                owner,
              );
              if (!snapshot)
                throw new AppError({
                  statusCode: 404,
                  code: 'NOT_FOUND',
                  message: 'Private product not found',
                });
              if (
                hasUnsupportedMascaraCategory(
                  snapshot.identity.familyName,
                  snapshot.identity.variantName,
                )
              )
                return {
                  state: 'UNAVAILABLE',
                  slotIndex,
                  reason: 'UNSUPPORTED_CATEGORY',
                };
              return {
                state: 'PRIVATE_READY',
                slotIndex,
                snapshot: privateProductSnapshotContract(snapshot),
              };
            }
            if (normalizeGtin(slot.gtin).kind === 'INVALID')
              return {
                state: 'UNAVAILABLE',
                slotIndex,
                reason: 'INVALID_GTIN',
              };
            try {
              const { variant } = await options.catalog.byGtin(slot.gtin);
              return {
                state: 'CATALOG_READY',
                slotIndex,
                gtin: slot.gtin,
                variant,
                review: null,
              };
            } catch (error) {
              if (
                !(error instanceof AppError) ||
                ![404, 503].includes(error.statusCode)
              )
                throw error;
              const unsupported =
                typeof error.details === 'object' &&
                error.details !== null &&
                'reason' in error.details &&
                error.details.reason === 'UNSUPPORTED_CATEGORY';
              return {
                state: 'UNAVAILABLE',
                slotIndex,
                reason: unsupported
                  ? 'UNSUPPORTED_CATEGORY'
                  : error.statusCode === 404
                    ? 'NOT_FOUND'
                    : 'SOURCE_UNAVAILABLE',
              };
            }
          },
        ),
      );

      const gtins = new Set<string>();
      const variantIds = new Set<string>();
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        if (!slot || slot.state === 'UNAVAILABLE') continue;
        const gtin14 =
          slot.state === 'CATALOG_READY'
            ? slot.variant.barcode.gtin14
            : slot.snapshot.barcode.gtin14;
        const variantId =
          slot.state === 'CATALOG_READY' ? slot.variant.productVariantId : null;
        if (
          gtins.has(gtin14) ||
          (variantId !== null && variantIds.has(variantId))
        ) {
          slots[index] = {
            state: 'UNAVAILABLE',
            slotIndex: slot.slotIndex,
            reason: 'DUPLICATE_VARIANT',
          };
        }
        gtins.add(gtin14);
        if (variantId !== null) variantIds.add(variantId);
      }
      const signals = await options.reviews.findByProductVariantIds(
        slots.flatMap((slot) =>
          slot.state === 'CATALOG_READY' ? [slot.variant.productVariantId] : [],
        ),
      );
      const candidates: ComparisonCandidate[] = slots.map((slot) => {
        if (slot.state === 'UNAVAILABLE')
          return {
            state: 'BLOCKED',
            slotIndex: slot.slotIndex,
            gtin: '',
            reason: slot.reason,
          };
        if (slot.state === 'CATALOG_READY') {
          const review = signals.get(slot.variant.productVariantId) ?? null;
          slot.review = publicReview(review);
          return {
            state: 'READY',
            slotIndex: slot.slotIndex,
            gtin: slot.gtin,
            productVariantId: `catalog:${slot.variant.productVariantId}`,
            identitySource: 'CATALOG',
            isWaterproof: slot.variant.isWaterproof,
            formulaText: slot.variant.formula?.inciText ?? null,
            formulaComplete: true,
            claimKinds: slot.variant.claims.map((claim) => claim.kind),
            review,
          };
        }
        return {
          state: 'READY',
          slotIndex: slot.slotIndex,
          gtin: slot.snapshot.barcode.value,
          productVariantId: `private:${slot.snapshot.snapshotId}`,
          identitySource: 'USER_CONFIRMED_PACKAGING',
          isWaterproof: slot.snapshot.identity.isWaterproof,
          formulaText: slot.snapshot.revision.sourceText,
          formulaComplete: slot.snapshot.formulaComplete,
          claimKinds: slot.snapshot.claimKinds,
          priceKopecks: slot.snapshot.priceKopecks,
          review: null,
        };
      });
      const domain = compareMascaras({
        candidates,
        brief: input.brief,
        now: options.now?.() ?? new Date(),
        dictionary:
          input.brief.avoidedIngredients.length > 0
            ? await options.dictionary.findPublishedSnapshot()
            : null,
      });
      const hasPrivate = input.slots.some((slot) => slot.kind === 'PRIVATE');
      const warnings: string[] = [];
      if (hasPrivate) {
        warnings.push(
          'Личные карточки подтверждены вами по упаковке, а не опубликованным каталогом. Их состав, свойства и цена не проверены независимо.',
        );
        warnings.push(
          'Отзывы каталога не переносятся на личные карточки: для них отзывов пока нет.',
        );
      }
      if (
        slots.some(
          (slot) =>
            slot.state === 'PRIVATE_READY' && !slot.snapshot.formulaComplete,
        )
      )
        warnings.push(
          'Неполный личный состав не подтверждает отсутствие исключённых ингредиентов.',
        );
      if (input.brief.sensitiveEyes || input.brief.contactLenses)
        warnings.push(
          'Нет данных о подходящести для чувствительных глаз или контактных линз. Результат не является медицинской рекомендацией.',
        );
      const decision = domain.recommendation;
      let recommendation: PrivateComparisonResponse['comparison']['recommendation'];
      if (decision.kind === 'PREFERRED') {
        const winner = candidates.find(
          (candidate) =>
            candidate.state === 'READY' &&
            candidate.productVariantId === decision.productVariantId,
        );
        if (!winner) throw new Error('Comparison winner has no resolved slot');
        recommendation = {
          kind: 'PREFERRED',
          slotIndex: winner.slotIndex,
          framing: 'BETTER_FIT',
          confidence:
            hasPrivate && decision.confidence === 'HIGH'
              ? 'MEDIUM'
              : decision.confidence,
          reasonCodes: [...decision.reasonCodes],
        };
      } else
        recommendation = {
          ...decision,
          reasonCodes: [...decision.reasonCodes],
        };
      return {
        comparison: {
          schemaVersion: 1,
          rulesVersion: 'private-mascara-comparison-v1',
          mode: input.brief.mode,
          slots,
          warnings,
          recommendation,
          criteria: domain.criteria.map((criterion) => ({
            kind: criterion.kind,
            observations: criterion.observations.map((item) => ({
              slotIndex: item.slotIndex,
              outcome: item.outcome,
              confidence: item.confidence,
              reasonCode: item.reasonCode,
              explanation: explanations[item.reasonCode],
              evidence: [...item.evidence],
            })),
          })),
        },
      };
    },
  };
}
