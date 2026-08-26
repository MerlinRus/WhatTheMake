import { Type, type Static } from 'typebox';

import { GtinFormatSchema } from './catalog.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';
import { MediaCollectionSchema } from './media.js';

const GtinValueSchema = Type.String({
  pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
});

export const CreateProductObservationInputSchema = Type.Object(
  { gtin: GtinValueSchema },
  { additionalProperties: false },
);

export type CreateProductObservationInput = Static<
  typeof CreateProductObservationInputSchema
>;

export const ProductObservationParamsSchema = Type.Object(
  { observationId: UuidSchema },
  { additionalProperties: false },
);

export type ProductObservationParams = Static<
  typeof ProductObservationParamsSchema
>;

export const ProductObservationSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    observationId: UuidSchema,
    barcode: Type.Object(
      {
        value: GtinValueSchema,
        format: GtinFormatSchema,
        gtin14: Type.String({ pattern: '^[0-9]{14}$' }),
      },
      { additionalProperties: false },
    ),
    mediaCollection: MediaCollectionSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export type ProductObservation = Static<typeof ProductObservationSchema>;

export const ProductObservationResponseSchema = Type.Object(
  { observation: ProductObservationSchema },
  { additionalProperties: false },
);

export type ProductObservationResponse = Static<
  typeof ProductObservationResponseSchema
>;

export const CatalogPromotionIdentitySchema = Type.Object(
  {
    brandName: Type.String({ minLength: 1, maxLength: 200 }),
    familyName: Type.String({ minLength: 1, maxLength: 300 }),
    variantName: Type.String({ minLength: 1, maxLength: 300 }),
    shadeName: Type.Union([
      Type.String({ minLength: 1, maxLength: 200 }),
      Type.Null(),
    ]),
    netQuantity: Type.Union([
      Type.Object(
        {
          value: Type.String({
            pattern: '^[0-9]{1,8}(?:\\.[0-9]{1,4})?$',
          }),
          unit: Type.Union([Type.Literal('MILLILITER'), Type.Literal('GRAM')]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    isWaterproof: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { additionalProperties: false },
);

export type CatalogPromotionIdentity = Static<
  typeof CatalogPromotionIdentitySchema
>;

export const CreateProductObservationConfirmationInputSchema = Type.Object(
  { identity: CatalogPromotionIdentitySchema },
  { additionalProperties: false },
);

export type CreateProductObservationConfirmationInput = Static<
  typeof CreateProductObservationConfirmationInputSchema
>;

export const CatalogPromotionSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal('WAITING_FOR_MATCH'),
      matchingAccountCount: Type.Integer({ minimum: 1 }),
      productVariantId: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('NEEDS_MODERATION'),
      matchingAccountCount: Type.Integer({ minimum: 1 }),
      productVariantId: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('PUBLISHED'),
      matchingAccountCount: Type.Integer({ minimum: 1 }),
      productVariantId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export type CatalogPromotion = Static<typeof CatalogPromotionSchema>;

export const ProductObservationConfirmationResponseSchema = Type.Object(
  { promotion: CatalogPromotionSchema },
  { additionalProperties: false },
);

export type ProductObservationConfirmationResponse = Static<
  typeof ProductObservationConfirmationResponseSchema
>;
