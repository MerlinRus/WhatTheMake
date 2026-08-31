import { Type, type Static } from 'typebox';

import { CatalogVariantSchema } from './catalog.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';
import { MascaraBriefInputSchema } from './mascara-preferences.js';
import { ExternalProductCandidateSchema } from './product-discovery.js';

const GtinSchema = Type.String({
  pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
});

export const ComparisonPreviewInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    gtins: Type.Array(GtinSchema, {
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
    }),
    brief: MascaraBriefInputSchema,
  },
  { additionalProperties: false },
);

export type ComparisonPreviewInput = Static<
  typeof ComparisonPreviewInputSchema
>;

export const ComparisonReviewSignalSchema = Type.Object(
  {
    ratingValue: Type.Number({ minimum: 1, maximum: 5 }),
    reviewCount: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    asOf: IsoDateTimeSchema,
    sourceQuality: Type.Union([
      Type.Literal('LOW'),
      Type.Literal('MEDIUM'),
      Type.Literal('HIGH'),
    ]),
  },
  { additionalProperties: false },
);

export type ComparisonReviewSignal = Static<
  typeof ComparisonReviewSignalSchema
>;

export const ComparisonSlotSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal('READY'),
      slotIndex: Type.Integer({ minimum: 0, maximum: 2 }),
      gtin: GtinSchema,
      variant: CatalogVariantSchema,
      review: Type.Union([ComparisonReviewSignalSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('EXTERNAL_CANDIDATE'),
      slotIndex: Type.Integer({ minimum: 0, maximum: 2 }),
      gtin: GtinSchema,
      candidate: ExternalProductCandidateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('NOT_FOUND'),
      slotIndex: Type.Integer({ minimum: 0, maximum: 2 }),
      gtin: GtinSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('INVALID_GTIN'),
      slotIndex: Type.Integer({ minimum: 0, maximum: 2 }),
      gtin: GtinSchema,
      reason: Type.Union([
        Type.Literal('INVALID_LENGTH'),
        Type.Literal('NON_DIGIT'),
        Type.Literal('INVALID_CHECKSUM'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('DUPLICATE_VARIANT'),
      slotIndex: Type.Integer({ minimum: 0, maximum: 2 }),
      gtin: GtinSchema,
      productVariantId: UuidSchema,
      earlierSlotIndex: Type.Integer({ minimum: 0, maximum: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type ComparisonSlot = Static<typeof ComparisonSlotSchema>;

export const ComparisonCriterionKindSchema = Type.Union([
  Type.Literal('IDENTITY_AND_DATA'),
  Type.Literal('HARD_CONSTRAINTS'),
  Type.Literal('DESIRED_EFFECT'),
  Type.Literal('CUSTOMER_REVIEWS'),
  Type.Literal('FORMULA_AND_CLAIMS'),
  Type.Literal('PRICE_AND_VALUE'),
]);

export const ComparisonReasonCodeSchema = Type.Union([
  Type.Literal('INSUFFICIENT_READY_SLOTS'),
  Type.Literal('EXTERNAL_IDENTITY_UNCONFIRMED'),
  Type.Literal('DUPLICATE_VARIANT'),
  Type.Literal('REVIEW_DATA_UNAVAILABLE'),
  Type.Literal('EVIDENCE_TOO_CLOSE'),
  Type.Literal('CONFLICTING_CRITERIA'),
  Type.Literal('HARD_CONSTRAINT_DATA_MISSING'),
  Type.Literal('NO_SUPPORTED_DIFFERENCE'),
  Type.Literal('EXACT_CATALOG_IDENTITY'),
  Type.Literal('WATERPROOF_MATCH'),
  Type.Literal('WATERPROOF_CONFLICT'),
  Type.Literal('AVOIDED_INGREDIENT_PRESENT'),
  Type.Literal('AVOIDED_INGREDIENT_ABSENT'),
  Type.Literal('GOAL_CLAIM_MATCH'),
  Type.Literal('GOAL_CLAIM_NOT_FOUND'),
  Type.Literal('REVIEW_EVIDENCE_COMPARED'),
  Type.Literal('FORMULA_AVAILABLE'),
  Type.Literal('FORMULA_DATA_UNAVAILABLE'),
  Type.Literal('PRICE_DATA_UNAVAILABLE'),
]);

export type ComparisonReasonCode = Static<typeof ComparisonReasonCodeSchema>;

export const ComparisonCriterionObservationSchema = Type.Object(
  {
    slotIndex: Type.Integer({ minimum: 0, maximum: 2 }),
    productVariantId: Type.Union([UuidSchema, Type.Null()]),
    outcome: Type.Union([
      Type.Literal('ADVANTAGE'),
      Type.Literal('DISADVANTAGE'),
      Type.Literal('NEUTRAL'),
      Type.Literal('NO_DATA'),
    ]),
    confidence: Type.Union([
      Type.Literal('LOW'),
      Type.Literal('MEDIUM'),
      Type.Literal('HIGH'),
    ]),
    reasonCode: ComparisonReasonCodeSchema,
    explanation: Type.String({ minLength: 1, maxLength: 500 }),
    evidence: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
      maxItems: 8,
    }),
  },
  { additionalProperties: false },
);

export const ComparisonCriterionSchema = Type.Object(
  {
    kind: ComparisonCriterionKindSchema,
    observations: Type.Array(ComparisonCriterionObservationSchema, {
      minItems: 2,
      maxItems: 3,
    }),
  },
  { additionalProperties: false },
);

export const ComparisonRecommendationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('PREFERRED'),
      productVariantId: UuidSchema,
      framing: Type.Literal('BETTER_FIT'),
      confidence: Type.Union([
        Type.Literal('LOW'),
        Type.Literal('MEDIUM'),
        Type.Literal('HIGH'),
      ]),
      reasonCodes: Type.Array(ComparisonReasonCodeSchema, {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('NO_CLEAR_WINNER'),
      confidence: Type.Union([Type.Literal('LOW'), Type.Literal('MEDIUM')]),
      reasonCodes: Type.Array(ComparisonReasonCodeSchema, {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
]);

export const ComparisonPreviewResponseSchema = Type.Object(
  {
    comparison: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        rulesVersion: Type.Literal('mascara-comparison-v1'),
        mode: Type.Union([
          Type.Literal('UNKNOWN_GOALS'),
          Type.Literal('PERSONALIZED'),
        ]),
        slots: Type.Array(ComparisonSlotSchema, {
          minItems: 2,
          maxItems: 3,
        }),
        recommendation: ComparisonRecommendationSchema,
        criteria: Type.Array(ComparisonCriterionSchema, {
          minItems: 6,
          maxItems: 6,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ComparisonPreviewResponse = Static<
  typeof ComparisonPreviewResponseSchema
>;
