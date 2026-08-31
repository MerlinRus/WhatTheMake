import type {
  ComparisonPreviewInput,
  ComparisonPreviewResponse,
  ComparisonReviewSignal,
  ComparisonSlot,
} from '@wtm/contracts';
import {
  compareMascaras,
  normalizeGtin,
  type ComparisonCandidate,
  type ComparisonReasonCode,
  type ComparisonReviewSignal as DomainReviewSignal,
} from '@wtm/domain';

import type { CatalogLookupService } from '../catalog/service.js';
import { AppError } from '../errors.js';
import type { ProductDiscoveryService } from '../product-discovery/service.js';

export interface ComparisonReviewSignalProvider {
  findByProductVariantIds(
    productVariantIds: readonly string[],
  ): Promise<ReadonlyMap<string, DomainReviewSignal>>;
}

export interface ComparisonService {
  preview(input: ComparisonPreviewInput): Promise<ComparisonPreviewResponse>;
}

const explanations: Record<ComparisonReasonCode, string> = {
  INSUFFICIENT_READY_SLOTS:
    'Недостаточно подтверждённых вариантов для сравнения.',
  EXTERNAL_IDENTITY_UNCONFIRMED:
    'Внешняя карточка найдена, но её вариант ещё не подтверждён нашим каталогом.',
  DUPLICATE_VARIANT: 'Этот штрихкод указывает на уже добавленный вариант.',
  REVIEW_DATA_UNAVAILABLE: 'Нет разрешённых данных об отзывах покупателей.',
  EVIDENCE_TOO_CLOSE: 'Доступные данные слишком близки для уверенного выбора.',
  CONFLICTING_CRITERIA: 'Критерии дают противоречивый результат.',
  HARD_CONSTRAINT_DATA_MISSING:
    'Не хватает данных, чтобы проверить выбранное обязательное условие.',
  NO_SUPPORTED_DIFFERENCE: 'Подтверждённого различия по этому критерию нет.',
  EXACT_CATALOG_IDENTITY: 'Вариант точно сопоставлен по опубликованному GTIN.',
  WATERPROOF_MATCH: 'Водостойкость соответствует вашему условию.',
  WATERPROOF_CONFLICT: 'Водостойкость противоречит вашему условию.',
  AVOIDED_INGREDIENT_PRESENT: 'В составе найдено указанное исключение.',
  AVOIDED_INGREDIENT_ABSENT:
    'Указанные исключения не найдены точным совпадением в составе.',
  GOAL_CLAIM_MATCH: 'Заявление производителя совпадает с выбранным эффектом.',
  GOAL_CLAIM_NOT_FOUND: 'Подходящее заявление производителя не опубликовано.',
  REVIEW_EVIDENCE_COMPARED: 'Сопоставлены доверенные агрегированные отзывы.',
  FORMULA_AVAILABLE: 'Опубликован актуальный состав варианта.',
  FORMULA_DATA_UNAVAILABLE: 'Подтверждённый состав пока недоступен.',
  PRICE_DATA_UNAVAILABLE: 'Нет разрешённых данных о цене.',
};

function publicReview(
  signal: DomainReviewSignal | null,
): ComparisonReviewSignal | null {
  return signal === null
    ? null
    : {
        ratingValue: signal.ratingValue,
        reviewCount: signal.reviewCount,
        asOf: signal.asOf.toISOString(),
        sourceQuality: signal.sourceQuality,
      };
}

function catalogCandidate(
  slot: Extract<ComparisonSlot, { state: 'READY' }>,
): ComparisonCandidate {
  return {
    state: 'READY',
    slotIndex: slot.slotIndex,
    gtin: slot.gtin,
    productVariantId: slot.variant.productVariantId,
    isWaterproof: slot.variant.isWaterproof,
    formulaText: slot.variant.formula?.inciText ?? null,
    claimKinds: slot.variant.claims.map((claim) => claim.kind),
    review:
      slot.review === null
        ? null
        : { ...slot.review, asOf: new Date(slot.review.asOf) },
  };
}

function blockedCandidate(
  slot: Exclude<ComparisonSlot, { state: 'READY' }>,
): ComparisonCandidate {
  return {
    state: 'BLOCKED',
    slotIndex: slot.slotIndex,
    gtin: slot.gtin,
    reason: slot.state,
  };
}

async function lookupSlot(options: {
  gtin: string;
  slotIndex: number;
  catalog: CatalogLookupService;
  discovery: ProductDiscoveryService;
}): Promise<ComparisonSlot> {
  const normalized = normalizeGtin(options.gtin);
  if (normalized.kind === 'INVALID') {
    return {
      state: 'INVALID_GTIN',
      slotIndex: options.slotIndex,
      gtin: options.gtin,
      reason: normalized.reason,
    };
  }
  try {
    const found = await options.catalog.byGtin(options.gtin);
    return {
      state: 'READY',
      slotIndex: options.slotIndex,
      gtin: options.gtin,
      variant: found.variant,
      review: null,
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
    const discovered = await options.discovery.byGtin(options.gtin);
    return discovered.discovery.state === 'FOUND'
      ? {
          state: 'EXTERNAL_CANDIDATE',
          slotIndex: options.slotIndex,
          gtin: options.gtin,
          candidate: discovered.discovery.candidate,
        }
      : {
          state: 'NOT_FOUND',
          slotIndex: options.slotIndex,
          gtin: options.gtin,
        };
  }
}

function deduplicateResolvedVariants(slots: ComparisonSlot[]): void {
  const firstByVariant = new Map<string, number>();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot?.state !== 'READY') continue;
    const earlierSlotIndex = firstByVariant.get(slot.variant.productVariantId);
    if (earlierSlotIndex === undefined) {
      firstByVariant.set(slot.variant.productVariantId, slot.slotIndex);
      continue;
    }
    slots[index] = {
      state: 'DUPLICATE_VARIANT',
      slotIndex: slot.slotIndex,
      gtin: slot.gtin,
      productVariantId: slot.variant.productVariantId,
      earlierSlotIndex,
    };
  }
}

export function createNoDataComparisonReviewSignalProvider(): ComparisonReviewSignalProvider {
  return {
    async findByProductVariantIds() {
      return new Map();
    },
  };
}

export function createComparisonService(options: {
  catalog: CatalogLookupService;
  discovery: ProductDiscoveryService;
  reviews: ComparisonReviewSignalProvider;
  now?: () => Date;
}): ComparisonService {
  const now = options.now ?? (() => new Date());
  return {
    async preview(input) {
      if (new Set(input.gtins).size !== input.gtins.length) {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'GTIN values must be distinct',
        });
      }
      const slots = await Promise.all(
        input.gtins.map((gtin, slotIndex) =>
          lookupSlot({
            gtin,
            slotIndex,
            catalog: options.catalog,
            discovery: options.discovery,
          }),
        ),
      );
      deduplicateResolvedVariants(slots);

      const readyIds = slots.flatMap((slot) =>
        slot.state === 'READY' ? [slot.variant.productVariantId] : [],
      );
      const reviews = await options.reviews.findByProductVariantIds(readyIds);
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        if (slot?.state !== 'READY') continue;
        slots[index] = {
          ...slot,
          review: publicReview(
            reviews.get(slot.variant.productVariantId) ?? null,
          ),
        };
      }

      const domain = compareMascaras({
        candidates: slots.map((slot) =>
          slot.state === 'READY'
            ? catalogCandidate(slot)
            : blockedCandidate(slot),
        ),
        brief: input.brief,
        now: now(),
      });

      return {
        comparison: {
          schemaVersion: 1,
          rulesVersion: 'mascara-comparison-v1',
          mode: input.brief.mode,
          slots,
          recommendation:
            domain.recommendation.kind === 'PREFERRED'
              ? {
                  ...domain.recommendation,
                  framing: 'BETTER_FIT',
                  reasonCodes: [...domain.recommendation.reasonCodes],
                }
              : {
                  ...domain.recommendation,
                  reasonCodes: [...domain.recommendation.reasonCodes],
                },
          criteria: domain.criteria.map((criterion) => ({
            kind: criterion.kind,
            observations: criterion.observations.map((item) => ({
              ...item,
              explanation: explanations[item.reasonCode],
              evidence: [...item.evidence],
            })),
          })),
        },
      };
    },
  };
}
