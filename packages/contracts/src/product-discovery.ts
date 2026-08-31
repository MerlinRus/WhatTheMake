import { Type, type Static } from 'typebox';

import { CatalogBarcodeParamsSchema } from './catalog.js';
import { IsoDateTimeSchema } from './common.js';

const ExactGtinSchema = Type.String({
  pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
});

export const ProductDiscoveryParamsSchema = CatalogBarcodeParamsSchema;

export type ProductDiscoveryParams = Static<
  typeof ProductDiscoveryParamsSchema
>;

export const ProductDiscoveryProviderSchema = Type.Literal('OPEN_BEAUTY_FACTS');

export const ExternalProductCandidateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    gtin: ExactGtinSchema,
    confidence: Type.Literal('LOW'),
    provider: ProductDiscoveryProviderSchema,
    providerLabel: Type.Literal('Open Beauty Facts'),
    productUrl: Type.String({
      pattern:
        '^https://world\\.openbeautyfacts\\.org/product/(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
      maxLength: 256,
    }),
    fetchedAt: IsoDateTimeSchema,
    brandName: Type.Union([
      Type.String({ minLength: 1, maxLength: 200 }),
      Type.Null(),
    ]),
    productName: Type.String({ minLength: 1, maxLength: 300 }),
    quantity: Type.Union([
      Type.String({ minLength: 1, maxLength: 100 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export type ExternalProductCandidate = Static<
  typeof ExternalProductCandidateSchema
>;

export const ProductDiscoveryUnavailableReasonSchema = Type.Union([
  Type.Literal('TIMEOUT'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('UPSTREAM_ERROR'),
  Type.Literal('INVALID_RESPONSE'),
  Type.Literal('DISABLED'),
]);

export const ProductDiscoveryResultSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal('FOUND'),
      candidate: ExternalProductCandidateSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('NOT_FOUND'),
      gtin: ExactGtinSchema,
      provider: ProductDiscoveryProviderSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal('UNAVAILABLE'),
      gtin: ExactGtinSchema,
      provider: ProductDiscoveryProviderSchema,
      reason: ProductDiscoveryUnavailableReasonSchema,
    },
    { additionalProperties: false },
  ),
]);

export type ProductDiscoveryResult = Static<
  typeof ProductDiscoveryResultSchema
>;

export const ProductDiscoveryResponseSchema = Type.Object(
  { discovery: ProductDiscoveryResultSchema },
  { additionalProperties: false },
);

export type ProductDiscoveryResponse = Static<
  typeof ProductDiscoveryResponseSchema
>;
