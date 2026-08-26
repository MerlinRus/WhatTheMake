import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import type { CatalogProvenanceInput } from '@wtm/domain';
import { normalizeGtin } from '@wtm/domain';
import { createPostgresDatabase } from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';
import { createCatalogLookupService } from '../src/catalog/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const provenance: CatalogProvenanceInput = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Official manufacturer catalog',
  sourceUri: 'https://manufacturer.example/catalog',
  sourceRecordId: 'catalog-variant-1',
  observedAt: new Date('2026-08-26T08:00:00.000Z'),
  rightsStatus: 'ALLOWED',
};

test(
  'GTIN endpoint returns exact published variant and stable not-found flow',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 4,
      applicationName: 'wtm-catalog-api-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(`
      TRUNCATE
        wtm_product_claims,
        wtm_formula_revisions,
        wtm_product_barcodes,
        wtm_product_variants,
        wtm_product_families,
        wtm_catalog_provenance
      CASCADE
    `);

    const family = await database.catalog.createFamily(
      {
        category: 'MASCARA',
        brandName: 'Example Beauty',
        name: 'Decision Mascara',
      },
      provenance,
    );
    const variantResult = await database.catalog.createVariant(
      {
        productFamilyId: family.productFamilyId,
        name: 'Black / 10 ml / washable',
        shadeName: 'Black',
        netQuantityValue: '10',
        netQuantityUnit: 'MILLILITER',
        waterproof: false,
      },
      provenance,
    );
    assert.equal(variantResult.kind, 'CREATED');
    if (variantResult.kind !== 'CREATED') throw new Error('unreachable');
    const variant = variantResult.variant;

    const normalized = normalizeGtin('4006381333931');
    assert.equal(normalized.kind, 'VALID');
    if (normalized.kind !== 'VALID') throw new Error('unreachable');
    await database.catalog.attachBarcode(
      variant.productVariantId,
      normalized.gtin,
      provenance,
    );
    const formula = await database.catalog.createFormulaRevision(
      variant.productVariantId,
      'AQUA, WAX, CI 77499',
      provenance,
    );
    assert.equal(formula.kind, 'CREATED');
    if (formula.kind !== 'CREATED') throw new Error('unreachable');
    const claim = await database.catalog.createClaim(
      {
        productVariantId: variant.productVariantId,
        formulaRevisionId: formula.revision.formulaRevisionId,
        kind: 'VOLUME',
        text: 'Visible volume',
      },
      provenance,
    );
    assert.equal(claim.kind, 'CREATED');
    if (claim.kind !== 'CREATED') throw new Error('unreachable');

    await database.catalog.transitionFamilyStatus(
      family.productFamilyId,
      'PUBLISHED',
    );
    await database.catalog.transitionVariantStatus(
      variant.productVariantId,
      'PUBLISHED',
    );
    await adminPool.query(
      `
        UPDATE wtm_product_claims
        SET status = 'PUBLISHED', published_at = now(), updated_at = now()
        WHERE id = $1
      `,
      [claim.claim.productClaimId],
    );

    const app = await buildApp({
      database,
      catalog: {
        service: createCatalogLookupService({ repository: database.catalog }),
      },
      onClose: () => database.close(),
    });

    try {
      const known = await app.inject({
        method: 'GET',
        url: '/api/v1/catalog/barcodes/4006381333931',
      });
      assert.equal(known.statusCode, 200);
      assert.match(String(known.headers['cache-control']), /max-age=60/);
      assert.equal(
        known.json().variant.productVariantId,
        variant.productVariantId,
      );
      assert.equal(known.json().variant.identification.confidence, 'EXACT');
      assert.equal(known.json().variant.barcode.format, 'EAN_13');
      assert.equal(known.json().variant.formula.revisionNumber, 1);
      assert.equal(known.json().variant.claims[0].kind, 'VOLUME');
      assert.equal(
        known.json().variant.identitySources.barcode.sourceKind,
        'MANUFACTURER',
      );
      const serialized = JSON.stringify(known.json().variant);
      assert.equal(serialized.includes('rightsStatus'), false);
      assert.equal(serialized.includes('sourceRecordId'), false);

      const equivalent = await app.inject({
        method: 'GET',
        url: '/api/v1/catalog/barcodes/04006381333931',
      });
      assert.equal(equivalent.statusCode, 200);
      assert.equal(
        equivalent.json().variant.productVariantId,
        variant.productVariantId,
      );
      assert.equal(equivalent.json().variant.barcode.format, 'GTIN_14');

      const invalidChecksum = await app.inject({
        method: 'GET',
        url: '/api/v1/catalog/barcodes/4006381333932',
      });
      assert.equal(invalidChecksum.statusCode, 400);
      assert.equal(invalidChecksum.json().error.code, 'VALIDATION_ERROR');
      assert.equal(
        invalidChecksum.json().error.details.reason,
        'INVALID_CHECKSUM',
      );

      const malformed = await app.inject({
        method: 'GET',
        url: '/api/v1/catalog/barcodes/not-a-barcode',
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, 'VALIDATION_ERROR');

      const unknown = await app.inject({
        method: 'GET',
        url: '/api/v1/catalog/barcodes/5901234123457',
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error.code, 'NOT_FOUND');
      assert.equal(unknown.json().error.message, 'Catalog variant not found');
    } finally {
      await app.close();
      await adminPool.end();
    }
  },
);
