import type {
  FastifyInstance,
  onRequestHookHandler,
  onSendHookHandler,
} from 'fastify';
import { Type } from 'typebox';
import { ApiErrorEnvelopeSchema, PasswordSchema } from '@wtm/contracts';
import type {
  AccountErasureInput,
  AccountErasureService,
} from '../account-erasure/service.js';
import { isSessionToken } from '../identity/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export interface AccountErasureRoutesOptions {
  service: AccountErasureService;
  publicOrigin: string;
  cookieName: string;
  secureCookie: boolean;
}
const noStore: onRequestHookHandler = async (_request, reply) => {
  reply.header('Cache-Control', 'private, no-store');
};
const noStoreResponse: onSendHookHandler = async (_request, reply, payload) => {
  reply.header('Cache-Control', 'private, no-store');
  return payload;
};

export async function registerAccountErasureRoutes(
  app: FastifyInstance,
  options: AccountErasureRoutesOptions,
): Promise<void> {
  app.delete<{ Body: AccountErasureInput; Reply: null }>(
    '/api/v1/accounts/current',
    {
      onRequest: [noStore, requireJson],
      onSend: noStoreResponse,
      preHandler: requireSameOrigin(options.publicOrigin),
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        body: Type.Object(
          { password: PasswordSchema, confirmation: Type.Literal('DELETE') },
          { additionalProperties: false },
        ),
        response: {
          204: Type.Null(),
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const value = sessionTokenCookie(request, options.cookieName);
      await options.service.erase(
        isSessionToken(value) ? value : null,
        request.body,
      );
      reply.clearCookie(options.cookieName, {
        path: '/',
        httpOnly: true,
        secure: options.secureCookie,
        sameSite: 'lax',
      });
      return reply.code(204).send(null);
    },
  );
}
