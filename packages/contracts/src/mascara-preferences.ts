import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema } from './common.js';

export const MascaraGoalSchema = Type.Union([
  Type.Literal('VOLUME'),
  Type.Literal('LENGTH'),
  Type.Literal('SEPARATION'),
  Type.Literal('NATURAL_LOOK'),
]);

export type MascaraGoal = Static<typeof MascaraGoalSchema>;

export const WaterproofPreferenceSchema = Type.Union([
  Type.Literal('REQUIRED'),
  Type.Literal('AVOID'),
  Type.Literal('NO_PREFERENCE'),
]);

export type WaterproofPreference = Static<typeof WaterproofPreferenceSchema>;

export const RemovalPreferenceSchema = Type.Union([
  Type.Literal('EASY_REQUIRED'),
  Type.Literal('NO_PREFERENCE'),
]);

export type RemovalPreference = Static<typeof RemovalPreferenceSchema>;

const sharedInputProperties = {
  waterproof: WaterproofPreferenceSchema,
  removal: RemovalPreferenceSchema,
  sensitiveEyes: Type.Boolean(),
  contactLenses: Type.Boolean(),
  avoidedIngredients: Type.Array(
    Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '.*\\S.*',
    }),
    { maxItems: 50 },
  ),
};

export const PersonalizedMascaraBriefInputSchema = Type.Object(
  {
    mode: Type.Literal('PERSONALIZED'),
    goals: Type.Array(MascaraGoalSchema, {
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
    }),
    ...sharedInputProperties,
  },
  { additionalProperties: false },
);

export const UnknownGoalsMascaraBriefInputSchema = Type.Object(
  {
    mode: Type.Literal('UNKNOWN_GOALS'),
    ...sharedInputProperties,
  },
  { additionalProperties: false },
);

export const MascaraBriefInputSchema = Type.Union([
  PersonalizedMascaraBriefInputSchema,
  UnknownGoalsMascaraBriefInputSchema,
]);

export type MascaraBriefInput = Static<typeof MascaraBriefInputSchema>;

const snapshotProperties = {
  schemaVersion: Type.Literal(1),
  waterproof: WaterproofPreferenceSchema,
  removal: RemovalPreferenceSchema,
  sensitiveEyes: Type.Boolean(),
  contactLenses: Type.Boolean(),
  avoidedIngredients: Type.Array(
    Type.String({ minLength: 1, maxLength: 128 }),
    {
      maxItems: 50,
    },
  ),
};

const personalizedSnapshotProperties = {
  mode: Type.Literal('PERSONALIZED'),
  goals: Type.Array(MascaraGoalSchema, {
    minItems: 1,
    maxItems: 4,
    uniqueItems: true,
  }),
  ...snapshotProperties,
};

const unknownGoalsSnapshotProperties = {
  mode: Type.Literal('UNKNOWN_GOALS'),
  goals: Type.Array(MascaraGoalSchema, { maxItems: 0 }),
  ...snapshotProperties,
};

export const MascaraBriefSnapshotSchema = Type.Union([
  Type.Object(personalizedSnapshotProperties, { additionalProperties: false }),
  Type.Object(unknownGoalsSnapshotProperties, { additionalProperties: false }),
]);

export type MascaraBriefSnapshot = Static<typeof MascaraBriefSnapshotSchema>;

const ephemeralMetadataProperties = {
  source: Type.Literal('EPHEMERAL'),
  profileVersion: Type.Null(),
  createdAt: IsoDateTimeSchema,
};

const accountMetadataProperties = {
  source: Type.Literal('ACCOUNT_PROFILE'),
  profileVersion: Type.Integer({ minimum: 1 }),
  createdAt: IsoDateTimeSchema,
};

export const MascaraBriefSchema = Type.Union([
  Type.Object(
    {
      ...personalizedSnapshotProperties,
      ...ephemeralMetadataProperties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...unknownGoalsSnapshotProperties,
      ...ephemeralMetadataProperties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...personalizedSnapshotProperties,
      ...accountMetadataProperties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...unknownGoalsSnapshotProperties,
      ...accountMetadataProperties,
    },
    { additionalProperties: false },
  ),
]);

export type MascaraBrief = Static<typeof MascaraBriefSchema>;

export const MascaraBriefResponseSchema = Type.Object(
  { brief: MascaraBriefSchema },
  { additionalProperties: false },
);

export type MascaraBriefResponse = Static<typeof MascaraBriefResponseSchema>;

export const MascaraPreferenceResponseSchema = Type.Object(
  { preference: Type.Union([MascaraBriefSchema, Type.Null()]) },
  { additionalProperties: false },
);

export type MascaraPreferenceResponse = Static<
  typeof MascaraPreferenceResponseSchema
>;
