import type { ProductDiscoveryResponse } from '@wtm/contracts';
import {
  normalizeGtin,
  type ExternalProductDiscoveryProvider,
} from '@wtm/domain';

import { AppError } from '../errors.js';

export interface ProductDiscoveryService {
  byGtin(input: string): Promise<ProductDiscoveryResponse>;
}

export function createProductDiscoveryService(options: {
  provider: ExternalProductDiscoveryProvider | null;
}): ProductDiscoveryService {
  return {
    async byGtin(input) {
      const normalized = normalizeGtin(input);
      if (normalized.kind === 'INVALID') {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid GTIN',
          details: { reason: normalized.reason },
        });
      }
      if (options.provider === null) {
        return {
          discovery: {
            state: 'UNAVAILABLE',
            gtin: normalized.gtin.value,
            provider: 'OPEN_BEAUTY_FACTS',
            reason: 'DISABLED',
          },
        };
      }

      const result = await options.provider.discover(normalized.gtin);
      const provider = result.provider ?? 'OPEN_BEAUTY_FACTS';
      if (result.gtin !== normalized.gtin.value) {
        return {
          discovery: {
            state: 'UNAVAILABLE',
            gtin: normalized.gtin.value,
            provider,
            reason: 'INVALID_RESPONSE',
          },
        };
      }
      if (result.kind === 'FOUND') {
        if (provider === 'EXTERNAL_CATALOGS') {
          return {
            discovery: {
              state: 'UNAVAILABLE',
              gtin: normalized.gtin.value,
              provider,
              reason: 'INVALID_RESPONSE',
            },
          };
        }
        return {
          discovery: {
            state: 'FOUND',
            candidate: {
              schemaVersion: 1,
              gtin: result.gtin,
              confidence: 'LOW',
              provider,
              providerLabel:
                provider === 'UPCITEMDB' ? 'UPCitemdb' : 'Open Beauty Facts',
              productUrl:
                provider === 'UPCITEMDB'
                  ? `https://www.upcitemdb.com/upc/${result.gtin}`
                  : `https://world.openbeautyfacts.org/product/${result.gtin}`,
              fetchedAt: result.fetchedAt.toISOString(),
              brandName: result.brandName,
              productName: result.productName,
              quantity: result.quantity,
              category: result.category ?? 'UNKNOWN',
            },
          },
        };
      }
      if (result.kind === 'NOT_FOUND') {
        return {
          discovery: {
            state: 'NOT_FOUND',
            gtin: result.gtin,
            provider,
          },
        };
      }
      return {
        discovery: {
          state: 'UNAVAILABLE',
          gtin: result.gtin,
          provider,
          reason: result.reason,
        },
      };
    },
  };
}
