import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  onSendHookHandler,
} from 'fastify';
import {
  ApiErrorEnvelopeSchema,
  CustomerReviewParamsSchema,
  CustomerReviewInputSchema,
  CustomerReviewOwnResponseSchema,
  CustomerReviewWriteResponseSchema,
  CustomerReviewDeleteInputSchema,
  CustomerReviewDeleteResponseSchema,
  CustomerReviewSummaryQuerySchema,
  CustomerReviewSummaryResponseSchema,
  type CustomerReviewParams,
  type CustomerReviewInput,
  type CustomerReviewOwnResponse,
  type CustomerReviewWriteResponse,
  type CustomerReviewDeleteResponse,
  type CustomerReviewDeleteInput,
  type CustomerReviewSummaryQuery,
  type CustomerReviewSummaryResponse,
} from '@wtm/contracts';
import type { CustomerReviewService } from '../customer-reviews/service.js';
import { isSessionToken } from '../identity/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export async function registerCustomerReviewRoutes(
  app: FastifyInstance,
  options: {
    service: CustomerReviewService;
    publicOrigin: string;
    cookieName: string;
  },
): Promise<void> {
  const noStore: onRequestHookHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  };
  const noStoreResponse: onSendHookHandler = async (
    _request,
    reply,
    payload,
  ) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  };
  const token = (request: FastifyRequest): string | null => {
    const value = sessionTokenCookie(request, options.cookieName);
    return isSessionToken(value) ? value : null;
  };
  const errors = {
    400: ApiErrorEnvelopeSchema,
    401: ApiErrorEnvelopeSchema,
    403: ApiErrorEnvelopeSchema,
    404: ApiErrorEnvelopeSchema,
    415: ApiErrorEnvelopeSchema,
    429: ApiErrorEnvelopeSchema,
  };
  app.get<{
    Params: CustomerReviewParams;
    Querystring: CustomerReviewSummaryQuery;
    Reply: CustomerReviewSummaryResponse;
  }>(
    '/api/v1/products/:productVariantId/reviews',
    {
      onRequest: noStore,
      onSend: noStoreResponse,
      config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
      schema: {
        params: CustomerReviewParamsSchema,
        querystring: CustomerReviewSummaryQuerySchema,
        response: { 200: CustomerReviewSummaryResponseSchema, ...errors },
      },
    },
    async (request) =>
      options.service.summary(
        request.params.productVariantId,
        request.query.limit,
      ),
  );
  app.get<{ Params: CustomerReviewParams; Reply: CustomerReviewOwnResponse }>(
    '/api/v1/products/:productVariantId/my-review',
    {
      onRequest: noStore,
      onSend: noStoreResponse,
      config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
      schema: {
        params: CustomerReviewParamsSchema,
        response: { 200: CustomerReviewOwnResponseSchema, ...errors },
      },
    },
    async (request) =>
      options.service.own(token(request), request.params.productVariantId),
  );
  app.put<{
    Params: CustomerReviewParams;
    Body: CustomerReviewInput;
    Reply: CustomerReviewWriteResponse;
  }>(
    '/api/v1/products/:productVariantId/my-review',
    {
      onRequest: [noStore, requireJson],
      onSend: noStoreResponse,
      preHandler: requireSameOrigin(options.publicOrigin),
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        params: CustomerReviewParamsSchema,
        body: CustomerReviewInputSchema,
        response: {
          200: CustomerReviewWriteResponseSchema,
          201: CustomerReviewWriteResponseSchema,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const result = await options.service.put(
        token(request),
        request.params.productVariantId,
        request.body,
      );
      return reply
        .code(result.resultKind === 'CREATED' ? 201 : 200)
        .send(result);
    },
  );
  app.delete<{
    Params: CustomerReviewParams;
    Body: CustomerReviewDeleteInput;
    Reply: CustomerReviewDeleteResponse;
  }>(
    '/api/v1/products/:productVariantId/my-review',
    {
      onRequest: [noStore, requireJson],
      onSend: noStoreResponse,
      preHandler: requireSameOrigin(options.publicOrigin),
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        params: CustomerReviewParamsSchema,
        body: CustomerReviewDeleteInputSchema,
        response: { 200: CustomerReviewDeleteResponseSchema, ...errors },
      },
    },
    async (request) =>
      options.service.delete(
        token(request),
        request.params.productVariantId,
        request.body.expectedAccountId,
      ),
  );
}
