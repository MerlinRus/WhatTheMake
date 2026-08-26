import { Type, type Static } from 'typebox';

export const UuidSchema = Type.String({
  format: 'uuid',
  description: 'RFC 4122 UUID',
});

export type Uuid = Static<typeof UuidSchema>;

export const RequestIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export type RequestId = Static<typeof RequestIdSchema>;

export const IsoDateTimeSchema = Type.String({ format: 'date-time' });
export type IsoDateTime = Static<typeof IsoDateTimeSchema>;

export const CursorQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    pageSize: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
    ),
  },
  { additionalProperties: false },
);

export type CursorQuery = Static<typeof CursorQuerySchema>;

export const CursorPageInfoSchema = Type.Object(
  {
    nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    hasNextPage: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type CursorPageInfo = Static<typeof CursorPageInfoSchema>;
