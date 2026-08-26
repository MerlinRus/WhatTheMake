import { createHash, randomBytes } from 'node:crypto';

import {
  AccountEmailConflictError,
  type AuthenticatedIdentity,
  type IdentityRepository,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import { createPasswordHasher, type PasswordHasher } from './passwords.js';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuedIdentitySession {
  identity: AuthenticatedIdentity;
  token: string | null;
  isNew: boolean;
}

export interface IdentityService {
  createGuestSession(
    existingToken: string | null,
  ): Promise<IssuedIdentitySession>;
  current(token: string | null): Promise<AuthenticatedIdentity | null>;
  deleteGuest(token: string | null): Promise<void>;
  register(
    input: { email: string; password: string },
    guestToken: string | null,
  ): Promise<IssuedIdentitySession>;
  login(
    input: { email: string; password: string },
    guestToken: string | null,
  ): Promise<IssuedIdentitySession>;
  logoutAccount(token: string | null): Promise<void>;
}

export function isSessionToken(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

function invalidCredentials(): AppError {
  return new AppError({
    statusCode: 401,
    code: 'UNAUTHENTICATED',
    message: 'Invalid email or password',
  });
}

export function createIdentityService(options: {
  repository: IdentityRepository;
  passwordHasher?: PasswordHasher;
  now?: () => Date;
}): IdentityService {
  const passwordHasher = options.passwordHasher ?? createPasswordHasher();
  const now = options.now ?? (() => new Date());

  return {
    async createGuestSession(existingToken): Promise<IssuedIdentitySession> {
      if (existingToken) {
        const existing = await options.repository.resolveSession(
          hashSessionToken(existingToken),
        );
        if (existing) {
          return { identity: existing, token: null, isNew: false };
        }
      }

      const token = newSessionToken();
      const identity = await options.repository.createGuestSession(
        hashSessionToken(token),
      );
      return { identity, token, isNew: true };
    },

    async current(token): Promise<AuthenticatedIdentity | null> {
      if (!token) return null;
      return options.repository.resolveSession(hashSessionToken(token));
    },

    async deleteGuest(token): Promise<void> {
      if (!token) return;
      const tokenHash = hashSessionToken(token);
      const identity = await options.repository.resolveSession(tokenHash);
      if (identity?.kind === 'ACCOUNT') {
        throw new AppError({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Guest session required',
        });
      }
      await options.repository.deleteGuestBySession(tokenHash);
    },

    async register(input, guestToken): Promise<IssuedIdentitySession> {
      const token = newSessionToken();
      try {
        const identity = await options.repository.createAccount({
          email: normalizeEmail(input.email),
          passwordHash: await passwordHasher.hash(input.password),
          sessionTokenHash: hashSessionToken(token),
          ...(guestToken
            ? { guestSessionTokenHash: hashSessionToken(guestToken) }
            : {}),
          expiresAt: new Date(now().getTime() + ACCOUNT_SESSION_LIFETIME_MS),
        });
        return { identity, token, isNew: true };
      } catch (error) {
        if (error instanceof AccountEmailConflictError) {
          throw new AppError({
            statusCode: 409,
            code: 'CONFLICT',
            message: 'Account already exists',
          });
        }
        throw error;
      }
    },

    async login(input, guestToken): Promise<IssuedIdentitySession> {
      const account = await options.repository.findAccountByEmail(
        normalizeEmail(input.email),
      );
      if (!account) {
        await passwordHasher.consume(input.password);
        throw invalidCredentials();
      }

      const passwordMatches = await passwordHasher.verify(
        input.password,
        account.passwordHash,
      );
      if (!passwordMatches || account.status !== 'ACTIVE') {
        throw invalidCredentials();
      }

      const token = newSessionToken();
      const identity = await options.repository.createAccountSession(
        account.accountId,
        hashSessionToken(token),
        new Date(now().getTime() + ACCOUNT_SESSION_LIFETIME_MS),
        guestToken ? hashSessionToken(guestToken) : undefined,
      );
      if (!identity) throw invalidCredentials();
      return { identity, token, isNew: true };
    },

    async logoutAccount(token): Promise<void> {
      if (!token) return;
      const tokenHash = hashSessionToken(token);
      const identity = await options.repository.resolveSession(tokenHash);
      if (identity?.kind === 'GUEST') {
        throw new AppError({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Account session required',
        });
      }
      await options.repository.revokeSession(tokenHash);
    },
  };
}
