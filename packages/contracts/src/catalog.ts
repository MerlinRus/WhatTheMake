import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const GtinFormatSchema = Type.Union([
  Type.Literal('EAN_8'),
  Type.Literal('UPC_A'),
  Type.Literal('EAN_13'),
  Type.Literal('GTIN_14'),
]);

export type GtinFormat = Static<typeof GtinFormatSchema>;

export const CatalogBarcodeParamsSchema = Type.Object(
  {
    gtin: Type.String({
      pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
    }),
  },
  { additionalProperties: false },
);

export type CatalogBarcodeParams = Static<typeof CatalogBarcodeParamsSchema>;

export const CatalogSourceKindSchema = Type.Union([
  Type.Literal('MANUFACTURER'),
  Type.Literal('REGULATOR'),
  Type.Literal('CONTROLLED_IMPORT'),
  Type.Literal('USER_OBSERVATION'),
  Type.Literal('ADMIN'),
]);

export const CatalogSourceSchema = Type.Object(
  {
    sourceKind: CatalogSourceKindSchema,
    sourceLabel: Type.String({ minLength: 1, maxLength: 500 }),
    sourceUrl: Type.Union([
      Type.String({ pattern: '^https?://', maxLength: 2048 }),
      Type.Null(),
    ]),
    observedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    importedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export type CatalogSource = Static<typeof CatalogSourceSchema>;

export const ProductClaimKindSchema = Type.Union([
  Type.Literal('VOLUME'),
  Type.Literal('LENGTH'),
  Type.Literal('SEPARATION'),
  Type.Literal('NATURAL_LOOK'),
  Type.Literal('WATERPROOF'),
  Type.Literal('EASY_REMOVAL'),
  Type.Literal('OTHER'),
]);

export type ProductClaimKind = Static<typeof ProductClaimKindSchema>;

export const CatalogVariantSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    identification: Type.Object(
      {
        method: Type.Literal('GTIN'),
        confidence: Type.Literal('EXACT'),
      },
      { additionalProperties: false },
    ),
    barcode: Type.Object(
      {
        value: Type.String({ pattern: '^[0-9]{8,14}$' }),
        format: GtinFormatSchema,
        gtin14: Type.String({ pattern: '^[0-9]{14}$' }),
      },
      { additionalProperties: false },
    ),
    productVariantId: UuidSchema,
    productFamilyId: UuidSchema,
    category: Type.Literal('MASCARA'),
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
          value: Type.String({ pattern: '^[0-9]+(?:\\.[0-9]{1,4})?$' }),
          unit: Type.Union([Type.Literal('MILLILITER'), Type.Literal('GRAM')]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    isWaterproof: Type.Union([Type.Boolean(), Type.Null()]),
    formula: Type.Union([
      Type.Object(
        {
          formulaRevisionId: UuidSchema,
          revisionNumber: Type.Integer({ minimum: 1 }),
          inciText: Type.String({ minLength: 1, maxLength: 30000 }),
          source: CatalogSourceSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    claims: Type.Array(
      Type.Object(
        {
          productClaimId: UuidSchema,
          kind: ProductClaimKindSchema,
          text: Type.String({ minLength: 1, maxLength: 4000 }),
          source: CatalogSourceSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    identitySources: Type.Object(
      {
        family: CatalogSourceSchema,
        variant: CatalogSourceSchema,
        barcode: CatalogSourceSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type CatalogVariant = Static<typeof CatalogVariantSchema>;

export const CatalogVariantResponseSchema = Type.Object(
  {
    variant: CatalogVariantSchema,
  },
  { additionalProperties: false },
);

export type CatalogVariantResponse = Static<
  typeof CatalogVariantResponseSchema
>;
