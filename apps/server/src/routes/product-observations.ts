import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  CreateProductObservationConfirmationInputSchema,
  CreateProductObservationInputSchema,
  ProductObservationParamsSchema,
  ProductObservationResponseSchema,
  ProductObservationConfirmationResponseSchema,
  type CreateProductObservationConfirmationInput,
  type CreateProductObservationInput,
  type ProductObservationParams,
  type ProductObservationResponse,
  type ProductObservationConfirmationResponse,
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

  app.post<{
    Params: ProductObservationParams;
    Body: CreateProductObservationConfirmationInput;
    Reply: ProductObservationConfirmationResponse;
  }>(
    '/api/v1/product-observations/:observationId/confirmations',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        params: ProductObservationParamsSchema,
        body: CreateProductObservationConfirmationInputSchema,
        response: {
          200: ProductObservationConfirmationResponseSchema,
          201: ProductObservationConfirmationResponseSchema,
          202: ProductObservationConfirmationResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await options.service.confirm(
        token(request, options.cookieName),
        request.params.observationId,
        request.body.identity,
      );
      const statusCode =
        result.kind === 'REUSED'
          ? 200
          : result.promotion.state === 'NEEDS_MODERATION'
            ? 202
            : 201;
      return reply
        .header('Cache-Control', 'private, no-store')
        .code(statusCode)
        .send({ promotion: result.promotion });
    },
  );
}
