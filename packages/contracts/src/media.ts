import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const MediaRoleSchema = Type.Union([
  Type.Literal('FRONT'),
  Type.Literal('INGREDIENTS'),
  Type.Literal('CLAIMS'),
  Type.Literal('BARCODE'),
  Type.Literal('PRICE_TAG'),
]);

export type MediaRole = Static<typeof MediaRoleSchema>;

export const ImageMediaTypeSchema = Type.Union([
  Type.Literal('image/jpeg'),
  Type.Literal('image/png'),
  Type.Literal('image/webp'),
]);

export type ImageMediaType = Static<typeof ImageMediaTypeSchema>;

export const MediaAssetSchema = Type.Object(
  {
    assetId: UuidSchema,
    role: MediaRoleSchema,
    mediaType: ImageMediaTypeSchema,
    byteSize: Type.Integer({ minimum: 1, maximum: 8 * 1024 * 1024 }),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export type MediaAsset = Static<typeof MediaAssetSchema>;

export const MediaCollectionSchema = Type.Object(
  {
    collectionId: UuidSchema,
    assets: Type.Array(MediaAssetSchema, { maxItems: 5 }),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export type MediaCollection = Static<typeof MediaCollectionSchema>;

export const MediaCollectionResponseSchema = Type.Object(
  { collection: MediaCollectionSchema },
  { additionalProperties: false },
);

export type MediaCollectionResponse = Static<
  typeof MediaCollectionResponseSchema
>;

export const MediaAssetResponseSchema = Type.Object(
  { asset: MediaAssetSchema },
  { additionalProperties: false },
);

export type MediaAssetResponse = Static<typeof MediaAssetResponseSchema>;

export const MediaCollectionParamsSchema = Type.Object(
  { collectionId: UuidSchema },
  { additionalProperties: false },
);

export type MediaCollectionParams = Static<typeof MediaCollectionParamsSchema>;

export const MediaAssetParamsSchema = Type.Object(
  { assetId: UuidSchema },
  { additionalProperties: false },
);

export type MediaAssetParams = Static<typeof MediaAssetParamsSchema>;

export const CreateMediaAssetQuerySchema = Type.Object(
  { role: MediaRoleSchema },
  { additionalProperties: false },
);

export type CreateMediaAssetQuery = Static<typeof CreateMediaAssetQuerySchema>;
