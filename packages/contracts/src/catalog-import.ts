import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema } from './common.js';

export const CatalogImportRightsStatusSchema = Type.Union([
  Type.Literal('ALLOWED'),
  Type.Literal('UNKNOWN'),
  Type.Literal('RESTRICTED'),
]);

export const CatalogSeedSourceSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 500 }),
    uri: Type.String({ pattern: '^https://', maxLength: 2048 }),
    licenseName: Type.String({ minLength: 1, maxLength: 200 }),
    licenseUri: Type.String({ pattern: '^https://', maxLength: 2048 }),
    attribution: Type.String({ minLength: 1, maxLength: 1000 }),
    rightsStatus: CatalogImportRightsStatusSchema,
    retrievedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export const CatalogSeedProductSchema = Type.Object(
  {
    sourceRecordId: Type.String({ minLength: 1, maxLength: 500 }),
    gtin: Type.String({
      pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
    }),
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
            pattern: '^[0-9]+(?:\\.[0-9]{1,4})?$',
            maxLength: 13,
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

export type CatalogSeedProduct = Static<typeof CatalogSeedProductSchema>;

export const CatalogSeedManifestEnvelopeSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    datasetId: Type.String({
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
      maxLength: 100,
    }),
    datasetVersion: Type.String({
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$',
    }),
    source: CatalogSeedSourceSchema,
    products: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 1000 }),
  },
  { additionalProperties: false },
);

export type CatalogSeedManifestEnvelope = Static<
  typeof CatalogSeedManifestEnvelopeSchema
>;
