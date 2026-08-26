import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  MascaraBriefInputSchema,
  MascaraBriefResponseSchema,
  MascaraPreferenceResponseSchema,
  type MascaraBriefInput,
  type MascaraBriefResponse,
  type MascaraPreferenceResponse,
} from '@wtm/contracts';

import { isSessionToken } from '../identity/service.js';
import type { MascaraPreferencesService } from '../preferences/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export interface MascaraPreferencesRoutesOptions {
  service: MascaraPreferencesService;
  publicOrigin: string;
  cookieName: string;
}

function token(request: FastifyRequest, cookieName: string): string | null {
  const value = sessionTokenCookie(request, cookieName);
  return isSessionToken(value) ? value : null;
}

export async function registerMascaraPreferencesRoutes(
  app: FastifyInstance,
  options: MascaraPreferencesRoutesOptions,
): Promise<void> {
  const sameOrigin = requireSameOrigin(options.publicOrigin);

  app.post<{ Body: MascaraBriefInput; Reply: MascaraBriefResponse }>(
    '/api/v1/mascara-briefs',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
      schema: {
        body: MascaraBriefInputSchema,
        response: {
          200: MascaraBriefResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => ({
      brief: await options.service.ephemeralBrief(
        token(request, options.cookieName),
        request.body,
      ),
    }),
  );

  app.get<{ Reply: MascaraPreferenceResponse }>(
    '/api/v1/mascara-preferences/current',
    {
      schema: {
        response: {
          200: MascaraPreferenceResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      options.service.current(token(request, options.cookieName)),
  );

  app.post<{ Body: MascaraBriefInput; Reply: MascaraBriefResponse }>(
    '/api/v1/mascara-preferences',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        body: MascaraBriefInputSchema,
        response: {
          201: MascaraBriefResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const preference = await options.service.save(
        token(request, options.cookieName),
        request.body,
      );
      return reply.code(201).send({ brief: preference });
    },
  );
}
