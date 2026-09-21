import { Type, type Static } from 'typebox';

import { CatalogVariantSchema } from './catalog.js';
import { UuidSchema } from './common.js';
import {
  ComparisonCriterionKindSchema,
  ComparisonCriterionObservationSchema,
  ComparisonReasonCodeSchema,
  ComparisonReviewSignalSchema,
} from './comparison.js';
import { MascaraBriefInputSchema } from './mascara-preferences.js';
import { PrivateProductSnapshotSchema } from './private-product.js';

const SlotIndexSchema = Type.Integer({ minimum: 0, maximum: 2 });
const GtinSchema = Type.String({
  pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
});
export const PrivateComparisonInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    slots: Type.Array(
      Type.Union([
        Type.Object(
          { kind: Type.Literal('CATALOG'), gtin: GtinSchema },
          { additionalProperties: false },
        ),
        Type.Object(
          { kind: Type.Literal('PRIVATE'), snapshotId: UuidSchema },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 2, maxItems: 3 },
    ),
    brief: MascaraBriefInputSchema,
  },
  { additionalProperties: false },
);
export type PrivateComparisonInput = Static<
  typeof PrivateComparisonInputSchema
>;

export const PrivateComparisonSlotSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal('CATALOG_READY'),
      slotIndex: SlotIndexSchema,
      gtin: GtinSchema,
      variant: CatalogVariantSchema,
      review: Type.Union([ComparisonReviewSignalSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('PRIVATE_READY'),
      slotIndex: SlotIndexSchema,
      snapshot: PrivateProductSnapshotSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('UNAVAILABLE'),
      slotIndex: SlotIndexSchema,
      reason: Type.Union([
        Type.Literal('NOT_FOUND'),
        Type.Literal('INVALID_GTIN'),
        Type.Literal('SOURCE_UNAVAILABLE'),
        Type.Literal('UNSUPPORTED_CATEGORY'),
        Type.Literal('DUPLICATE_VARIANT'),
      ]),
    },
    { additionalProperties: false },
  ),
]);
export type PrivateComparisonSlot = Static<typeof PrivateComparisonSlotSchema>;

const ReasonCodesSchema = Type.Array(ComparisonReasonCodeSchema, {
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
});
export const PrivateComparisonResponseSchema = Type.Object(
  {
    comparison: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        rulesVersion: Type.Literal('private-mascara-comparison-v1'),
        mode: Type.Union([
          Type.Literal('UNKNOWN_GOALS'),
          Type.Literal('PERSONALIZED'),
        ]),
        slots: Type.Array(PrivateComparisonSlotSchema, {
          minItems: 2,
          maxItems: 3,
        }),
        warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          maxItems: 4,
        }),
        recommendation: Type.Union([
          Type.Object(
            {
              kind: Type.Literal('PREFERRED'),
              slotIndex: SlotIndexSchema,
              framing: Type.Literal('BETTER_FIT'),
              confidence: Type.Union([
                Type.Literal('LOW'),
                Type.Literal('MEDIUM'),
                Type.Literal('HIGH'),
              ]),
              reasonCodes: ReasonCodesSchema,
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal('NO_CLEAR_WINNER'),
              confidence: Type.Union([
                Type.Literal('LOW'),
                Type.Literal('MEDIUM'),
              ]),
              reasonCodes: ReasonCodesSchema,
            },
            { additionalProperties: false },
          ),
        ]),
        criteria: Type.Array(
          Type.Object(
            {
              kind: ComparisonCriterionKindSchema,
              observations: Type.Array(
                Type.Omit(ComparisonCriterionObservationSchema, [
                  'productVariantId',
                ]),
                { minItems: 2, maxItems: 3 },
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 6, maxItems: 6 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type PrivateComparisonResponse = Static<
  typeof PrivateComparisonResponseSchema
>;
