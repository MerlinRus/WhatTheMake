import { Type, type Static } from 'typebox';

import { PasswordSchema } from './identity.js';

export const RotateAccountRecoveryCodeInputSchema = Type.Object(
  { currentPassword: PasswordSchema },
  { additionalProperties: false },
);
export type RotateAccountRecoveryCodeInput = Static<
  typeof RotateAccountRecoveryCodeInputSchema
>;

export const RotateAccountRecoveryCodeResponseSchema = Type.Object(
  { recoveryCode: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) },
  { additionalProperties: false },
);
export type RotateAccountRecoveryCodeResponse = Static<
  typeof RotateAccountRecoveryCodeResponseSchema
>;

export const AccountRecoveryInputSchema = Type.Object(
  {
    // Shape errors and unknown credentials must not reveal account existence.
    email: Type.String({ maxLength: 254 }),
    code: Type.String({ maxLength: 128 }),
    newPassword: PasswordSchema,
  },
  { additionalProperties: false },
);
export type AccountRecoveryInput = Static<typeof AccountRecoveryInputSchema>;

export const AccountRecoveryResponseSchema = Type.Object(
  { reset: Type.Literal(true), requiresLogin: Type.Literal(true) },
  { additionalProperties: false },
);
export type AccountRecoveryResponse = Static<
  typeof AccountRecoveryResponseSchema
>;
