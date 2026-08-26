import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';

import {
  ApiErrorEnvelopeSchema,
  LoginInputSchema,
  RegisterAccountInputSchema,
  SessionResponseSchema,
  type IdentityPrincipal,
  type LoginInput,
  type RegisterAccountInput,
  type SessionResponse,
} from '@wtm/contracts';
import type { AuthenticatedIdentity } from '@wtm/domain';

import {
  isSessionToken,
  type IdentityService,
  type IssuedIdentitySession,
} from '../identity/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

const GUEST_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const ACCOUNT_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface IdentityRoutesOptions {
  service: IdentityService;
  publicOrigin: string;
  cookieName: string;
  secureCookie: boolean;
}

function principal(identity: AuthenticatedIdentity | null): IdentityPrincipal {
  if (!identity) return { kind: 'ANONYMOUS' };
  if (identity.kind === 'GUEST') {
    return {
      kind: 'GUEST',
      guestId: identity.guestId,
      createdAt: identity.createdAt.toISOString(),
    };
  }
  return {
    kind: 'ACCOUNT',
    accountId: identity.accountId,
    email: identity.email,
    createdAt: identity.createdAt.toISOString(),
  };
}

function sessionResponse(
  identity: AuthenticatedIdentity | null,
): SessionResponse {
  return { principal: principal(identity) };
}

function sessionToken(
  request: FastifyRequest,
  cookieName: string,
): string | null {
  const value = sessionTokenCookie(request, cookieName);
  return isSessionToken(value) ? value : null;
}

function setSessionCookie(
  reply: FastifyReply,
  options: IdentityRoutesOptions,
  token: string,
  kind: 'GUEST' | 'ACCOUNT',
): void {
  reply.setCookie(options.cookieName, token, {
    path: '/',
    httpOnly: true,
    secure: options.secureCookie,
    sameSite: 'lax',
    priority: 'high',
    maxAge:
      kind === 'GUEST'
        ? GUEST_COOKIE_MAX_AGE_SECONDS
        : ACCOUNT_COOKIE_MAX_AGE_SECONDS,
  });
}

function clearSessionCookie(
  reply: FastifyReply,
  options: IdentityRoutesOptions,
): void {
  reply.clearCookie(options.cookieName, {
    path: '/',
    httpOnly: true,
    secure: options.secureCookie,
    sameSite: 'lax',
  });
}

function issueSession(
  reply: FastifyReply,
  options: IdentityRoutesOptions,
  issued: IssuedIdentitySession,
): SessionResponse {
  if (issued.token) {
    setSessionCookie(reply, options, issued.token, issued.identity.kind);
  }
  return sessionResponse(issued.identity);
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: IdentityRoutesOptions,
): Promise<void> {
  const sameOrigin = requireSameOrigin(options.publicOrigin);

  app.post<{ Reply: SessionResponse }>(
    '/api/v1/guest-sessions',
    {
      preHandler: sameOrigin,
      config: {
        rateLimit: { max: 10, timeWindow: '1 hour' },
      },
      schema: {
        response: {
          200: SessionResponseSchema,
          201: SessionResponseSchema,
          403: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const issued = await options.service.createGuestSession(
        sessionToken(request, options.cookieName),
      );
      return reply
        .code(issued.isNew ? 201 : 200)
        .send(issueSession(reply, options, issued));
    },
  );

  app.get<{ Reply: SessionResponse }>(
    '/api/v1/session',
    { schema: { response: { 200: SessionResponseSchema } } },
    async (request, reply) => {
      const token = sessionToken(request, options.cookieName);
      const identity = await options.service.current(token);
      if (!identity && request.cookies[options.cookieName]) {
        clearSessionCookie(reply, options);
      } else if (identity?.kind === 'GUEST' && token) {
        setSessionCookie(reply, options, token, 'GUEST');
      }
      return sessionResponse(identity);
    },
  );

  app.delete<{ Reply: null }>(
    '/api/v1/guest-sessions/current',
    {
      preHandler: sameOrigin,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        response: {
          204: Type.Null(),
          403: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      await options.service.deleteGuest(
        sessionToken(request, options.cookieName),
      );
      clearSessionCookie(reply, options);
      return reply.code(204).send(null);
    },
  );

  app.post<{ Body: RegisterAccountInput; Reply: SessionResponse }>(
    '/api/v1/accounts',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      schema: {
        body: RegisterAccountInputSchema,
        response: {
          201: SessionResponseSchema,
          400: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const issued = await options.service.register(
        request.body,
        sessionToken(request, options.cookieName),
      );
      return reply.code(201).send(issueSession(reply, options, issued));
    },
  );

  app.post<{ Body: LoginInput; Reply: SessionResponse }>(
    '/api/v1/account-sessions',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: LoginInputSchema,
        response: {
          200: SessionResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const issued = await options.service.login(
        request.body,
        sessionToken(request, options.cookieName),
      );
      return reply.send(issueSession(reply, options, issued));
    },
  );

  app.delete<{ Reply: null }>(
    '/api/v1/account-sessions/current',
    {
      preHandler: sameOrigin,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        response: {
          204: Type.Null(),
          403: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      await options.service.logoutAccount(
        sessionToken(request, options.cookieName),
      );
      clearSessionCookie(reply, options);
      return reply.code(204).send(null);
    },
  );
}
