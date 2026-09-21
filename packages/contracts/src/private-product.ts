import { Type, type Static } from 'typebox';

import { GtinFormatSchema, ProductClaimKindSchema } from './catalog.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';
import { ProductObservationInciRevisionSchema } from './inci-correction.js';
import { CatalogPromotionIdentitySchema } from './product-observation.js';

const PriceKopecksSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  Type.Null(),
]);
const ClaimKindsSchema = Type.Array(ProductClaimKindSchema, {
  maxItems: 7,
  uniqueItems: true,
});

export const CreatePrivateProductSnapshotInputSchema = Type.Object(
  {
    category: Type.Literal('MASCARA'),
    identity: CatalogPromotionIdentitySchema,
    identityConfirmed: Type.Literal(true),
    revisionId: UuidSchema,
    formulaComplete: Type.Optional(Type.Boolean({ default: false })),
    claimKinds: ClaimKindsSchema,
    priceKopecks: PriceKopecksSchema,
  },
  { additionalProperties: false },
);
export type CreatePrivateProductSnapshotInput = Static<
  typeof CreatePrivateProductSnapshotInputSchema
>;

export const PrivateProductSnapshotParamsSchema = Type.Object(
  { snapshotId: UuidSchema },
  { additionalProperties: false },
);
export type PrivateProductSnapshotParams = Static<
  typeof PrivateProductSnapshotParamsSchema
>;

export const PrivateProductListQuerySchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) },
  { additionalProperties: false },
);
export type PrivateProductListQuery = Static<
  typeof PrivateProductListQuerySchema
>;

export const PrivateProductSnapshotSchema = Type.Object(
  {
    snapshotId: UuidSchema,
    observationId: UuidSchema,
    snapshotNumber: Type.Integer({ minimum: 1, maximum: 50 }),
    category: Type.Literal('MASCARA'),
    barcode: Type.Object(
      {
        value: Type.String({
          pattern: '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$',
        }),
        format: GtinFormatSchema,
        gtin14: Type.String({ pattern: '^[0-9]{14}$' }),
      },
      { additionalProperties: false },
    ),
    identity: CatalogPromotionIdentitySchema,
    identitySource: Type.Literal('USER_CONFIRMED_PACKAGING'),
    revision: ProductObservationInciRevisionSchema,
    formulaComplete: Type.Boolean(),
    claimKinds: ClaimKindsSchema,
    claimsSource: Type.Literal('USER_CONFIRMED_PACKAGING'),
    priceKopecks: PriceKopecksSchema,
    priceSource: Type.Union([Type.Literal('USER_ENTERED'), Type.Null()]),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type PrivateProductSnapshot = Static<
  typeof PrivateProductSnapshotSchema
>;

export const PrivateProductSnapshotResponseSchema = Type.Object(
  { snapshot: PrivateProductSnapshotSchema },
  { additionalProperties: false },
);
export type PrivateProductSnapshotResponse = Static<
  typeof PrivateProductSnapshotResponseSchema
>;

export const CreatePrivateProductSnapshotResponseSchema = Type.Object(
  {
    resultKind: Type.Union([Type.Literal('CREATED'), Type.Literal('REUSED')]),
    snapshot: PrivateProductSnapshotSchema,
  },
  { additionalProperties: false },
);
export type CreatePrivateProductSnapshotResponse = Static<
  typeof CreatePrivateProductSnapshotResponseSchema
>;

export const PrivateProductListResponseSchema = Type.Object(
  { snapshots: Type.Array(PrivateProductSnapshotSchema, { maxItems: 30 }) },
  { additionalProperties: false },
);
export type PrivateProductListResponse = Static<
  typeof PrivateProductListResponseSchema
>;
