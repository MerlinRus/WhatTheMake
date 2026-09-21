import type { FastifyInstance } from 'fastify';
import {
  ApiErrorEnvelopeSchema,
  PrivateComparisonInputSchema,
  PrivateComparisonResponseSchema,
  type PrivateComparisonInput,
  type PrivateComparisonResponse,
} from '@wtm/contracts';
import type { PrivateComparisonService } from '../comparison/private-service.js';
import { isSessionToken } from '../identity/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export async function registerPrivateComparisonRoutes(
  app: FastifyInstance,
  options: {
    service: PrivateComparisonService;
    publicOrigin: string;
    cookieName: string;
  },
): Promise<void> {
  app.post<{ Body: PrivateComparisonInput; Reply: PrivateComparisonResponse }>(
    '/api/v1/comparisons/private-preview',
    {
      onRequest: [
        async (_request, reply) => {
          reply.header('Cache-Control', 'private, no-store');
        },
        requireJson,
      ],
      onSend: async (_request, reply, payload) => {
        reply.header('Cache-Control', 'private, no-store');
        return payload;
      },
      preHandler: requireSameOrigin(options.publicOrigin),
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
      schema: {
        body: PrivateComparisonInputSchema,
        response: {
          200: PrivateComparisonResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const value = sessionTokenCookie(request, options.cookieName);
      return options.service.preview(
        isSessionToken(value) ? value : null,
        request.body,
      );
    },
  );
}
