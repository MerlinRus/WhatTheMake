import type { FastifyInstance } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  ProductDiscoveryParamsSchema,
  ProductDiscoveryResponseSchema,
  type ProductDiscoveryParams,
  type ProductDiscoveryResponse,
} from '@wtm/contracts';

import type { ProductDiscoveryService } from '../product-discovery/service.js';

export interface ProductDiscoveryRoutesOptions {
  service: ProductDiscoveryService;
}

export async function registerProductDiscoveryRoutes(
  app: FastifyInstance,
  options: ProductDiscoveryRoutesOptions,
): Promise<void> {
  app.get<{
    Params: ProductDiscoveryParams;
    Reply: ProductDiscoveryResponse;
  }>(
    '/api/v1/discovery/barcodes/:gtin',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: ProductDiscoveryParamsSchema,
        response: {
          200: ProductDiscoveryResponseSchema,
          400: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'private, no-store')
        .send(await options.service.byGtin(request.params.gtin)),
  );
}
