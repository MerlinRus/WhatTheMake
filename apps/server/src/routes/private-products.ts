import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  onSendHookHandler,
} from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  CreatePrivateProductSnapshotInputSchema,
  CreatePrivateProductSnapshotResponseSchema,
  PrivateProductListQuerySchema,
  PrivateProductListResponseSchema,
  PrivateProductSnapshotParamsSchema,
  PrivateProductSnapshotResponseSchema,
  ProductObservationParamsSchema,
  type CreatePrivateProductSnapshotInput,
  type CreatePrivateProductSnapshotResponse,
  type PrivateProductListQuery,
  type PrivateProductListResponse,
  type PrivateProductSnapshotParams,
  type PrivateProductSnapshotResponse,
  type ProductObservationParams,
} from '@wtm/contracts';

import { isSessionToken } from '../identity/service.js';
import type { PrivateProductService } from '../private-products/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export interface PrivateProductRoutesOptions {
  service: PrivateProductService;
  publicOrigin: string;
  cookieName: string;
}

function token(request: FastifyRequest, cookieName: string): string | null {
  const value = sessionTokenCookie(request, cookieName);
  return isSessionToken(value) ? value : null;
}

const noStore: onRequestHookHandler = async (_request, reply) => {
  reply.header('Cache-Control', 'private, no-store');
};

const noStoreResponse: onSendHookHandler = async (_request, reply, payload) => {
  reply.header('Cache-Control', 'private, no-store');
  return payload;
};

export async function registerPrivateProductRoutes(
  app: FastifyInstance,
  options: PrivateProductRoutesOptions,
): Promise<void> {
  app.post<{
    Params: ProductObservationParams;
    Body: CreatePrivateProductSnapshotInput;
    Reply: CreatePrivateProductSnapshotResponse;
  }>(
    '/api/v1/product-observations/:observationId/private-snapshots',
    {
      onRequest: [noStore, requireJson],
      onSend: noStoreResponse,
      preHandler: requireSameOrigin(options.publicOrigin),
      config: { rateLimit: { max: 50, timeWindow: '1 hour' } },
      schema: {
        params: ProductObservationParamsSchema,
        body: CreatePrivateProductSnapshotInputSchema,
        response: {
          200: CreatePrivateProductSnapshotResponseSchema,
          201: CreatePrivateProductSnapshotResponseSchema,
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
      const result = await options.service.create(
        token(request, options.cookieName),
        request.params.observationId,
        request.body,
      );
      return reply
        .code(result.resultKind === 'CREATED' ? 201 : 200)
        .send(result);
    },
  );

  app.get<{
    Querystring: PrivateProductListQuery;
    Reply: PrivateProductListResponse;
  }>(
    '/api/v1/private-products',
    {
      onRequest: noStore,
      onSend: noStoreResponse,
      config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
      schema: {
        querystring: PrivateProductListQuerySchema,
        response: {
          200: PrivateProductListResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      options.service.list(
        token(request, options.cookieName),
        request.query.limit,
      ),
  );

  app.get<{
    Params: PrivateProductSnapshotParams;
    Reply: PrivateProductSnapshotResponse;
  }>(
    '/api/v1/private-products/:snapshotId',
    {
      onRequest: noStore,
      onSend: noStoreResponse,
      config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
      schema: {
        params: PrivateProductSnapshotParamsSchema,
        response: {
          200: PrivateProductSnapshotResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      options.service.get(
        token(request, options.cookieName),
        request.params.snapshotId,
      ),
  );
}
