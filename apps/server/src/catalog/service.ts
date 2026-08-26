import type { CatalogSource, CatalogVariantResponse } from '@wtm/contracts';
import {
  normalizeGtin,
  type CatalogRepository,
  type PublishedCatalogSource,
} from '@wtm/domain';

import { AppError } from '../errors.js';

export interface CatalogLookupService {
  byGtin(input: string): Promise<CatalogVariantResponse>;
}

function source(value: PublishedCatalogSource): CatalogSource {
  let sourceUrl: string | null = null;
  if (value.sourceUri !== null) {
    try {
      const parsed = new URL(value.sourceUri);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        sourceUrl = parsed.href;
      }
    } catch {
      sourceUrl = null;
    }
  }
  return {
    sourceKind: value.sourceKind,
    sourceLabel: value.sourceLabel,
    sourceUrl,
    observedAt: value.observedAt?.toISOString() ?? null,
    importedAt: value.importedAt.toISOString(),
  };
}

export function createCatalogLookupService(options: {
  repository: CatalogRepository;
}): CatalogLookupService {
  return {
    async byGtin(input): Promise<CatalogVariantResponse> {
      const normalized = normalizeGtin(input);
      if (normalized.kind === 'INVALID') {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid GTIN',
          details: { reason: normalized.reason },
        });
      }

      const found = await options.repository.findPublishedVariantByGtin(
        normalized.gtin.gtin14,
      );
      if (!found) {
        throw new AppError({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Catalog variant not found',
        });
      }

      return {
        variant: {
          schemaVersion: 1,
          identification: { method: 'GTIN', confidence: 'EXACT' },
          barcode: {
            value: normalized.gtin.value,
            format: normalized.gtin.format,
            gtin14: normalized.gtin.gtin14,
          },
          productVariantId: found.productVariantId,
          productFamilyId: found.productFamilyId,
          category: found.category,
          brandName: found.brandName,
          familyName: found.familyName,
          variantName: found.variantName,
          shadeName: found.shadeName,
          netQuantity:
            found.netQuantityValue !== null && found.netQuantityUnit !== null
              ? {
                  value: found.netQuantityValue,
                  unit: found.netQuantityUnit,
                }
              : null,
          isWaterproof: found.waterproof,
          formula:
            found.formula === null
              ? null
              : {
                  formulaRevisionId: found.formula.formulaRevisionId,
                  revisionNumber: found.formula.revisionNumber,
                  inciText: found.formula.inciText,
                  source: source(found.formula.source),
                },
          claims: found.claims.map((claim) => ({
            productClaimId: claim.productClaimId,
            kind: claim.kind,
            text: claim.text,
            source: source(claim.source),
          })),
          identitySources: {
            family: source(found.identitySources.family),
            variant: source(found.identitySources.variant),
            barcode: source(found.identitySources.barcode),
          },
        },
      };
    },
  };
}
