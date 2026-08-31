import assert from 'node:assert/strict';
import test from 'node:test';

import { Value } from 'typebox/value';

import {
  ComparisonPreviewResponseSchema,
  ProductDiscoveryResponseSchema,
  type CatalogVariantResponse,
} from '@wtm/contracts';
import type { ExternalProductDiscoveryProvider } from '@wtm/domain';

import { buildApp } from '../src/app.js';
import type { CatalogLookupService } from '../src/catalog/service.js';
import {
  createComparisonService,
  createNoDataComparisonReviewSignalProvider,
} from '../src/comparison/service.js';
import { AppError } from '../src/errors.js';
import { createProductDiscoveryService } from '../src/product-discovery/service.js';

const source = {
  sourceKind: 'MANUFACTURER' as const,
  sourceLabel: 'Official catalog',
  sourceUrl: 'https://manufacturer.example/catalog',
  observedAt: '2026-08-31T08:00:00.000Z',
  importedAt: '2026-08-31T08:01:00.000Z',
};

function catalogVariant(
  gtin: string,
  productVariantId: string,
  productFamilyId: string,
  familyName: string,
): CatalogVariantResponse {
  return {
    variant: {
      schemaVersion: 1,
      identification: { method: 'GTIN', confidence: 'EXACT' },
      barcode: {
        value: gtin,
        format: 'EAN_13',
        gtin14: gtin.padStart(14, '0'),
      },
      productVariantId,
      productFamilyId,
      category: 'MASCARA',
      brandName: 'Lash Lab',
      familyName,
      variantName: 'Black / 10 ml',
      shadeName: 'Black',
      netQuantity: { value: '10.0000', unit: 'MILLILITER' },
      isWaterproof: false,
      formula: null,
      claims: [],
      identitySources: { family: source, variant: source, barcode: source },
    },
  };
}

const variants = new Map([
  [
    '4006381333931',
    catalogVariant(
      '4006381333931',
      'b0f9bf8f-c1d6-4803-8899-73ca3359eae2',
      'c85f8055-d0b2-4a06-8a6d-306f3c81ed1e',
      'Decision One',
    ),
  ],
  [
    '5901234123457',
    catalogVariant(
      '5901234123457',
      'd8c195c0-e563-4a1b-a625-19ad756a6e93',
      'e41eac8c-b301-496a-8786-7a7f31bfdd7c',
      'Decision Two',
    ),
  ],
]);

const catalog: CatalogLookupService = {
  async byGtin(input) {
    const found = variants.get(input);
    if (found !== undefined) return found;
    throw new AppError({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Catalog variant not found',
    });
  },
};

const provider: ExternalProductDiscoveryProvider = {
  async discover(gtin) {
    return gtin.value === '3560070791460'
      ? {
          kind: 'FOUND',
          gtin: gtin.value,
          brandName: 'External Brand',
          productName: 'External Mascara',
          quantity: '9 ml',
          fetchedAt: new Date('2026-08-31T09:00:00.000Z'),
        }
      : { kind: 'NOT_FOUND', gtin: gtin.value };
  },
};

const discovery = createProductDiscoveryService({ provider });
const comparison = createComparisonService({
  catalog,
  discovery,
  reviews: createNoDataComparisonReviewSignalProvider(),
  now: () => new Date('2026-08-31T12:00:00.000Z'),
});

test('discovery service emits a strict attributed low-confidence candidate', async () => {
  const result = await discovery.byGtin('3560070791460');
  assert.equal(Value.Check(ProductDiscoveryResponseSchema, result), true);
  assert.equal(result.discovery.state, 'FOUND');
  if (result.discovery.state === 'FOUND') {
    assert.equal(result.discovery.candidate.confidence, 'LOW');
    assert.equal(
      result.discovery.candidate.productUrl,
      'https://world.openbeautyfacts.org/product/3560070791460',
    );
  }
});

test('discovery service rejects a provider identity mismatch', async () => {
  const mismatched = createProductDiscoveryService({
    provider: {
      async discover() {
        return { kind: 'NOT_FOUND', gtin: '5901234123457' };
      },
    },
  });
  assert.deepEqual(await mismatched.byGtin('4006381333931'), {
    discovery: {
      state: 'UNAVAILABLE',
      gtin: '4006381333931',
      provider: 'OPEN_BEAUTY_FACTS',
      reason: 'INVALID_RESPONSE',
    },
  });
});

test('comparison service keeps external identity in-band and never selects it', async () => {
  const result = await comparison.preview({
    schemaVersion: 1,
    gtins: ['4006381333931', '3560070791460'],
    brief: {
      mode: 'UNKNOWN_GOALS',
      waterproof: 'NO_PREFERENCE',
      removal: 'NO_PREFERENCE',
      sensitiveEyes: false,
      contactLenses: false,
      avoidedIngredients: [],
    },
  });
  assert.equal(Value.Check(ComparisonPreviewResponseSchema, result), true);
  assert.equal(result.comparison.slots[1]?.state, 'EXTERNAL_CANDIDATE');
  assert.deepEqual(result.comparison.recommendation, {
    kind: 'NO_CLEAR_WINNER',
    confidence: 'LOW',
    reasonCodes: ['EXTERNAL_IDENTITY_UNCONFIRMED', 'INSUFFICIENT_READY_SLOTS'],
  });
});

test('public discovery and comparison routes validate, no-store and require same origin', async () => {
  const app = await buildApp({
    productDiscovery: { service: discovery },
    comparisons: {
      service: comparison,
      publicOrigin: 'https://whatthemake.ru',
    },
  });
  try {
    const found = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/barcodes/3560070791460',
    });
    assert.equal(found.statusCode, 200);
    assert.equal(found.headers['cache-control'], 'private, no-store');

    const compared = await app.inject({
      method: 'POST',
      url: '/api/v1/comparisons/preview',
      headers: {
        origin: 'https://whatthemake.ru',
        'content-type': 'application/json',
      },
      payload: {
        schemaVersion: 1,
        gtins: ['4006381333931', '5901234123457'],
        brief: {
          mode: 'UNKNOWN_GOALS',
          waterproof: 'NO_PREFERENCE',
          removal: 'NO_PREFERENCE',
          sensitiveEyes: false,
          contactLenses: false,
          avoidedIngredients: [],
        },
      },
    });
    assert.equal(compared.statusCode, 200);
    assert.equal(compared.headers['cache-control'], 'private, no-store');
    assert.equal(
      Value.Check(ComparisonPreviewResponseSchema, compared.json()),
      true,
    );

    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/comparisons/preview',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      payload: {
        schemaVersion: 1,
        gtins: ['4006381333931', '5901234123457'],
        brief: {
          mode: 'UNKNOWN_GOALS',
          waterproof: 'NO_PREFERENCE',
          removal: 'NO_PREFERENCE',
          sensitiveEyes: false,
          contactLenses: false,
          avoidedIngredients: [],
        },
      },
    });
    assert.equal(crossOrigin.statusCode, 403);
  } finally {
    await app.close();
  }
});
