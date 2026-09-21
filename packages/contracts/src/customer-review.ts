import { Type, type Static } from 'typebox';
import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const CustomerReviewParamsSchema = Type.Object(
  { productVariantId: UuidSchema },
  { additionalProperties: false },
);
export type CustomerReviewParams = Static<typeof CustomerReviewParamsSchema>;
export const CustomerReviewInputSchema = Type.Object(
  {
    stars: Type.Integer({ minimum: 1, maximum: 5 }),
    text: Type.String({ minLength: 20, maxLength: 4000 }),
    expectedAccountId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);
export type CustomerReviewInput = Static<typeof CustomerReviewInputSchema>;
const ReviewStatusSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('APPROVED'),
  Type.Literal('REJECTED'),
  Type.Literal('DELETED'),
]);
export const CustomerReviewSchema = Type.Object(
  {
    reviewId: UuidSchema,
    productVariantId: UuidSchema,
    revisionNumber: Type.Integer({ minimum: 1 }),
    stars: Type.Integer({ minimum: 1, maximum: 5 }),
    text: Type.String({ minLength: 20, maxLength: 4000 }),
    status: ReviewStatusSchema,
    duplicateText: Type.Boolean(),
    verifiedPurchase: Type.Literal(false),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);
export type CustomerReview = Static<typeof CustomerReviewSchema>;
export const CustomerReviewOwnResponseSchema = Type.Object(
  { review: Type.Union([CustomerReviewSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type CustomerReviewOwnResponse = Static<
  typeof CustomerReviewOwnResponseSchema
>;
export const CustomerReviewWriteResponseSchema = Type.Object(
  {
    resultKind: Type.Union([
      Type.Literal('CREATED'),
      Type.Literal('UPDATED'),
      Type.Literal('UNCHANGED'),
    ]),
    review: CustomerReviewSchema,
  },
  { additionalProperties: false },
);
export type CustomerReviewWriteResponse = Static<
  typeof CustomerReviewWriteResponseSchema
>;
export const CustomerReviewDeleteInputSchema = Type.Object(
  { expectedAccountId: Type.Optional(UuidSchema) },
  { additionalProperties: false },
);
export type CustomerReviewDeleteInput = Static<
  typeof CustomerReviewDeleteInputSchema
>;
export const CustomerReviewDeleteResponseSchema = Type.Object(
  { deleted: Type.Literal(true) },
  { additionalProperties: false },
);
export type CustomerReviewDeleteResponse = Static<
  typeof CustomerReviewDeleteResponseSchema
>;
export const CustomerReviewSummaryQuerySchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) },
  { additionalProperties: false },
);
export type CustomerReviewSummaryQuery = Static<
  typeof CustomerReviewSummaryQuerySchema
>;
export const CustomerReviewMentionsSchema = Type.Object(
  {
    source: Type.Literal('WTM'),
    sampleSize: Type.Integer({ minimum: 3, maximum: 20 }),
    asOf: IsoDateTimeSchema,
    topics: Type.Array(
      Type.Object(
        {
          topic: Type.Union([
            Type.Literal('VOLUME'),
            Type.Literal('LENGTH'),
            Type.Literal('CLUMPING'),
            Type.Literal('FLAKING'),
            Type.Literal('REMOVAL'),
            Type.Literal('WATERPROOF'),
          ]),
          matchedReviewCount: Type.Integer({ minimum: 1, maximum: 20 }),
          reviewIds: Type.Array(UuidSchema, {
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  { additionalProperties: false },
);
export type CustomerReviewMentions = Static<
  typeof CustomerReviewMentionsSchema
>;
export const CustomerReviewSummaryResponseSchema = Type.Object(
  {
    summary: Type.Object(
      {
        source: Type.Literal('WTM'),
        sourceQuality: Type.Literal('LOW'),
        verifiedPurchase: Type.Literal(false),
        ratingValue: Type.Union([
          Type.Number({ minimum: 1, maximum: 5 }),
          Type.Null(),
        ]),
        reviewCount: Type.Integer({ minimum: 0 }),
        asOf: Type.Union([IsoDateTimeSchema, Type.Null()]),
        mentions: Type.Optional(CustomerReviewMentionsSchema),
        reviews: Type.Array(
          Type.Object(
            {
              reviewId: UuidSchema,
              stars: Type.Integer({ minimum: 1, maximum: 5 }),
              text: Type.String({ minLength: 20, maxLength: 4000 }),
              verifiedPurchase: Type.Literal(false),
              createdAt: IsoDateTimeSchema,
            },
            { additionalProperties: false },
          ),
          { maxItems: 20 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type CustomerReviewSummaryResponse = Static<
  typeof CustomerReviewSummaryResponseSchema
>;
