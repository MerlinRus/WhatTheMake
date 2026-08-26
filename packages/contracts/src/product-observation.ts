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
