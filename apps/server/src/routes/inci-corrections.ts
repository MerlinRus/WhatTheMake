import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  CreateProductObservationInciRevisionInputSchema,
  CreateProductObservationInciRevisionResponseSchema,
  ProductObservationInciAnalysisResponseSchema,
  ProductObservationInciParamsSchema,
  ProductObservationInciRevisionParamsSchema,
  ProductObservationInciWorkspaceResponseSchema,
  type CreateProductObservationInciRevisionInput,
  type CreateProductObservationInciRevisionResponse,
  type ProductObservationInciAnalysisResponse,
  type ProductObservationInciParams,
  type ProductObservationInciRevisionParams,
  type ProductObservationInciWorkspaceResponse,
} from '@wtm/contracts';

import { isSessionToken } from '../identity/service.js';
import type { InciCorrectionService } from '../inci-corrections/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export interface InciCorrectionRoutesOptions {
  service: InciCorrectionService;
  publicOrigin: string;
  cookieName: string;
}

function token(request: FastifyRequest, cookieName: string): string | null {
  const value = sessionTokenCookie(request, cookieName);
  return isSessionToken(value) ? value : null;
}

export async function registerInciCorrectionRoutes(
  app: FastifyInstance,
  options: InciCorrectionRoutesOptions,
): Promise<void> {
  const sameOrigin = requireSameOrigin(options.publicOrigin);

  app.get<{
    Params: ProductObservationInciParams;
    Reply: ProductObservationInciWorkspaceResponse;
  }>(
    '/api/v1/product-observations/:observationId/inci-revisions',
    {
      schema: {
        params: ProductObservationInciParamsSchema,
        response: {
          200: ProductObservationInciWorkspaceResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await options.service.workspace(
            token(request, options.cookieName),
            request.params.observationId,
          ),
        ),
  );

  app.post<{
    Params: ProductObservationInciParams;
    Body: CreateProductObservationInciRevisionInput;
    Reply: CreateProductObservationInciRevisionResponse;
  }>(
    '/api/v1/product-observations/:observationId/inci-revisions',
    {
      onRequest: requireJson,
      preHandler: sameOrigin,
      config: { rateLimit: { max: 50, timeWindow: '1 hour' } },
      schema: {
        params: ProductObservationInciParamsSchema,
        body: CreateProductObservationInciRevisionInputSchema,
        response: {
          200: CreateProductObservationInciRevisionResponseSchema,
          201: CreateProductObservationInciRevisionResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await options.service.createRevision(
        token(request, options.cookieName),
        request.params.observationId,
        request.body,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .code(result.resultKind === 'CREATED' ? 201 : 200)
        .send(result);
    },
  );

  app.get<{
    Params: ProductObservationInciRevisionParams;
    Reply: ProductObservationInciAnalysisResponse;
  }>(
    '/api/v1/product-observations/:observationId/inci-revisions/:revisionId/analysis',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
      schema: {
        params: ProductObservationInciRevisionParamsSchema,
        response: {
          200: ProductObservationInciAnalysisResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await options.service.analysis(
            token(request, options.cookieName),
            request.params.observationId,
            request.params.revisionId,
          ),
        ),
  );
}
