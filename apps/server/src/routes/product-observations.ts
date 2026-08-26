import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  CreateProductObservationInputSchema,
  ProductObservationParamsSchema,
  ProductObservationResponseSchema,
  type CreateProductObservationInput,
  type ProductObservationParams,
  type ProductObservationResponse,
} from '@wtm/contracts';

import { isSessionToken } from '../identity/service.js';
import type { ProductObservationService } from '../product-observations/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export interface ProductObservationRoutesOptions {
  service: ProductObservationService;
  publicOrigin: string;
  cookieName: string;
}

function token(request: FastifyRequest, cookieName: string): string | null {
  const value = sessionTokenCookie(request, cookieName);
  return isSessionToken(value) ? value : null;
}

export async function registerProductObservationRoutes(
  app: FastifyInstance,
  options: ProductObservationRoutesOptions,
): Promise<void> {
  const sameOrigin = requireSameOrigin(options.publicOrigin);

  app.post<{
    Body: CreateProductObservationInput;
    Reply: ProductObservationResponse;
  }>(
    '/api/v1/product-observations',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        body: CreateProductObservationInputSchema,
        response: {
          200: ProductObservationResponseSchema,
          201: ProductObservationResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await options.service.create(
        token(request, options.cookieName),
        request.body.gtin,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .code(result.kind === 'CREATED' ? 201 : 200)
        .send({ observation: result.observation });
    },
  );

  app.get<{
    Params: ProductObservationParams;
    Reply: ProductObservationResponse;
  }>(
    '/api/v1/product-observations/:observationId',
    {
      schema: {
        params: ProductObservationParamsSchema,
        response: {
          200: ProductObservationResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const observation = await options.service.get(
        token(request, options.cookieName),
        request.params.observationId,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ observation });
    },
  );
}
