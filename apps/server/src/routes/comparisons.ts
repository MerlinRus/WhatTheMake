import type { FastifyInstance } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  ComparisonPreviewInputSchema,
  ComparisonPreviewResponseSchema,
  type ComparisonPreviewInput,
  type ComparisonPreviewResponse,
} from '@wtm/contracts';

import type { ComparisonService } from '../comparison/service.js';
import { requireJson, requireSameOrigin } from './request-security.js';

export interface ComparisonRoutesOptions {
  service: ComparisonService;
  publicOrigin: string;
}

export async function registerComparisonRoutes(
  app: FastifyInstance,
  options: ComparisonRoutesOptions,
): Promise<void> {
  app.post<{
    Body: ComparisonPreviewInput;
    Reply: ComparisonPreviewResponse;
  }>(
    '/api/v1/comparisons/preview',
    {
      onRequest: requireJson,
      preHandler: requireSameOrigin(options.publicOrigin),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: ComparisonPreviewInputSchema,
        response: {
          200: ComparisonPreviewResponseSchema,
          400: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'private, no-store')
        .send(await options.service.preview(request.body)),
  );
}
