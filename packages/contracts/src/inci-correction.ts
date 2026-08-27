import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const INCI_REVISION_SOURCE_MAX_LENGTH = 100_000;

export const ProductObservationInciParamsSchema = Type.Object(
  { observationId: UuidSchema },
  { additionalProperties: false },
);

export type ProductObservationInciParams = Static<
  typeof ProductObservationInciParamsSchema
>;

export const CreateProductObservationInciOcrInputSchema = Type.Object(
  { mediaAssetId: UuidSchema },
  { additionalProperties: false },
);

export type CreateProductObservationInciOcrInput = Static<
  typeof CreateProductObservationInciOcrInputSchema
>;

export const ProductObservationInciRevisionParamsSchema = Type.Object(
  { observationId: UuidSchema, revisionId: UuidSchema },
  { additionalProperties: false },
);

export type ProductObservationInciRevisionParams = Static<
  typeof ProductObservationInciRevisionParamsSchema
>;

const InciRevisionSourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('OCR'),
      mediaAssetId: UuidSchema,
      providerId: Type.String({ minLength: 1, maxLength: 100 }),
      providerVersion: Type.String({ minLength: 1, maxLength: 100 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('USER_TRANSCRIPTION') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('USER_CORRECTION'),
      basedOnRevisionId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ProductObservationInciRevisionSchema = Type.Object(
  {
    revisionId: UuidSchema,
    revisionNumber: Type.Integer({ minimum: 1, maximum: 50 }),
    source: InciRevisionSourceSchema,
    sourceText: Type.String({
      minLength: 1,
      maxLength: INCI_REVISION_SOURCE_MAX_LENGTH,
    }),
    sourceSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    authorKind: Type.Union([
      Type.Literal('SYSTEM'),
      Type.Literal('GUEST'),
      Type.Literal('ACCOUNT'),
    ]),
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export type ProductObservationInciRevision = Static<
  typeof ProductObservationInciRevisionSchema
>;

export const ProductObservationInciWorkspaceResponseSchema = Type.Object(
  {
    workspace: Type.Object(
      {
        original: Type.Union([
          ProductObservationInciRevisionSchema,
          Type.Null(),
        ]),
        latest: Type.Union([ProductObservationInciRevisionSchema, Type.Null()]),
        revisionCount: Type.Integer({ minimum: 0, maximum: 50 }),
        maxRevisions: Type.Literal(50),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ProductObservationInciWorkspaceResponse = Static<
  typeof ProductObservationInciWorkspaceResponseSchema
>;

export const CreateProductObservationInciRevisionInputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('USER_TRANSCRIPTION'),
      sourceText: Type.String({
        minLength: 1,
        maxLength: INCI_REVISION_SOURCE_MAX_LENGTH,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('USER_CORRECTION'),
      basedOnRevisionId: UuidSchema,
      sourceText: Type.String({
        minLength: 1,
        maxLength: INCI_REVISION_SOURCE_MAX_LENGTH,
      }),
    },
    { additionalProperties: false },
  ),
]);

export type CreateProductObservationInciRevisionInput = Static<
  typeof CreateProductObservationInciRevisionInputSchema
>;

export const CreateProductObservationInciRevisionResponseSchema = Type.Object(
  {
    resultKind: Type.Union([Type.Literal('CREATED'), Type.Literal('REUSED')]),
    revision: ProductObservationInciRevisionSchema,
  },
  { additionalProperties: false },
);

export type CreateProductObservationInciRevisionResponse = Static<
  typeof CreateProductObservationInciRevisionResponseSchema
>;

const InciParseSummarySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('PARSED'),
      tokenCount: Type.Integer({ minimum: 0 }),
      uncertainTokenCount: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('REJECTED'),
      reason: Type.Literal('SOURCE_TOO_LARGE'),
    },
    { additionalProperties: false },
  ),
]);

const InciNormalizationSummarySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('NOT_RUN'),
      reason: Type.Union([
        Type.Literal('PARSE_REJECTED'),
        Type.Literal('NO_PUBLISHED_DICTIONARY'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('COMPLETED'),
      canonicalizerVersion: Type.String({ minLength: 1, maxLength: 100 }),
      dictionaryVersion: Type.String({ minLength: 1, maxLength: 100 }),
      normalizerVersion: Type.String({ minLength: 1, maxLength: 100 }),
      componentCount: Type.Integer({ minimum: 0 }),
      resolvedCount: Type.Integer({ minimum: 0 }),
      ambiguousCount: Type.Integer({ minimum: 0 }),
      unresolvedCount: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
]);

export const ProductObservationInciAnalysisResponseSchema = Type.Object(
  {
    analysis: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        selectedRevisionId: UuidSchema,
        sourceSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
        parserVersion: Type.String({ minLength: 1, maxLength: 100 }),
        parse: InciParseSummarySchema,
        normalization: InciNormalizationSummarySchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ProductObservationInciAnalysisResponse = Static<
  typeof ProductObservationInciAnalysisResponseSchema
>;
