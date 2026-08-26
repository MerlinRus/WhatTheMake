import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema } from './common.js';

export const ServiceStateSchema = Type.Union([
  Type.Literal('UP'),
  Type.Literal('DOWN'),
]);
export type ServiceState = Static<typeof ServiceStateSchema>;

export const VersionSchema = Type.Object(
  {
    name: Type.Literal('what-the-make'),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    buildSha: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export type Version = Static<typeof VersionSchema>;

export const LiveResponseSchema = Type.Object(
  {
    status: Type.Literal('UP'),
    now: IsoDateTimeSchema,
    version: VersionSchema,
  },
  { additionalProperties: false },
);

export type LiveResponse = Static<typeof LiveResponseSchema>;

export const DependencyCheckSchema = Type.Object(
  {
    status: ServiceStateSchema,
    latencyMs: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type DependencyCheck = Static<typeof DependencyCheckSchema>;

export const ReadyResponseSchema = Type.Object(
  {
    status: ServiceStateSchema,
    now: IsoDateTimeSchema,
    version: VersionSchema,
    checks: Type.Object(
      { database: DependencyCheckSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ReadyResponse = Static<typeof ReadyResponseSchema>;
