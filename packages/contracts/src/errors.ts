import { Type, type Static } from 'typebox';

import { RequestIdSchema } from './common.js';

export const ApiErrorCodeSchema = Type.Union([
  Type.Literal('VALIDATION_ERROR'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('CONFLICT'),
  Type.Literal('UNAUTHENTICATED'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('SERVICE_UNAVAILABLE'),
  Type.Literal('DATABASE_UNAVAILABLE'),
  Type.Literal('INTERNAL_ERROR'),
]);

export type ApiErrorCode = Static<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = Type.Object(
  {
    code: ApiErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: 500 }),
    requestId: RequestIdSchema,
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ApiError = Static<typeof ApiErrorSchema>;

export const ApiErrorEnvelopeSchema = Type.Object(
  { error: ApiErrorSchema },
  { additionalProperties: false },
);

export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelopeSchema>;
