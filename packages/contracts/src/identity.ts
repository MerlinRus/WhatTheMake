import { Type, type Static } from 'typebox';

import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const EmailSchema = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
});

export type Email = Static<typeof EmailSchema>;

export const PasswordSchema = Type.String({ minLength: 12, maxLength: 128 });

export const RegisterAccountInputSchema = Type.Object(
  {
    email: EmailSchema,
    password: PasswordSchema,
  },
  { additionalProperties: false },
);

export type RegisterAccountInput = Static<typeof RegisterAccountInputSchema>;

export const LoginInputSchema = Type.Object(
  {
    email: EmailSchema,
    password: PasswordSchema,
  },
  { additionalProperties: false },
);

export type LoginInput = Static<typeof LoginInputSchema>;

export const AnonymousPrincipalSchema = Type.Object(
  { kind: Type.Literal('ANONYMOUS') },
  { additionalProperties: false },
);

export const GuestPrincipalSchema = Type.Object(
  {
    kind: Type.Literal('GUEST'),
    guestId: UuidSchema,
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export const AccountPrincipalSchema = Type.Object(
  {
    kind: Type.Literal('ACCOUNT'),
    accountId: UuidSchema,
    email: EmailSchema,
    createdAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export const IdentityPrincipalSchema = Type.Union([
  AnonymousPrincipalSchema,
  GuestPrincipalSchema,
  AccountPrincipalSchema,
]);

export type IdentityPrincipal = Static<typeof IdentityPrincipalSchema>;

export const SessionResponseSchema = Type.Object(
  { principal: IdentityPrincipalSchema },
  { additionalProperties: false },
);

export type SessionResponse = Static<typeof SessionResponseSchema>;
