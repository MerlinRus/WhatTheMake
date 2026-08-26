import type { FastifyInstance } from 'fastify';

import {
  ApiErrorEnvelopeSchema,
  CatalogBarcodeParamsSchema,
  CatalogVariantResponseSchema,
  type CatalogBarcodeParams,
  type CatalogVariantResponse,
} from '@wtm/contracts';

import type { CatalogLookupService } from '../catalog/service.js';

export interface CatalogRoutesOptions {
  service: CatalogLookupService;
}

export async function registerCatalogRoutes(
  app: FastifyInstance,
  options: CatalogRoutesOptions,
): Promise<void> {
  app.get<{
    Params: CatalogBarcodeParams;
    Reply: CatalogVariantResponse;
  }>(
    '/api/v1/catalog/barcodes/:gtin',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: CatalogBarcodeParamsSchema,
        response: {
          200: CatalogVariantResponseSchema,
          400: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const response = await options.service.byGtin(request.params.gtin);
      return reply
        .header(
          'Cache-Control',
          'public, max-age=60, stale-while-revalidate=300',
        )
        .send(response);
    },
  );
}
