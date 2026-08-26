import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import {
  canTransitionCatalogStatus,
  normalizeGtin,
  type CatalogProvenanceInput,
} from '@wtm/domain';

import { createPostgresDatabase } from '../src/index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const allowedProvenance: CatalogProvenanceInput = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Manufacturer catalog 2026-08',
  sourceUri: 'https://manufacturer.example/catalog',
  sourceRecordId: 'mascara-001',
  observedAt: new Date('2026-08-26T08:00:00.000Z'),
  rightsStatus: 'ALLOWED',
};

const unknownProvenance: CatalogProvenanceInput = {
  sourceKind: 'USER_OBSERVATION',
  sourceLabel: 'Unconfirmed package photo',
  sourceUri: null,
  sourceRecordId: null,
  observedAt: new Date('2026-08-26T08:05:00.000Z'),
  rightsStatus: 'UNKNOWN',
};

test(
  'catalog separates family and variant, protects GTIN, and revisions INCI',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 4,
      applicationName: 'wtm-catalog-integration',
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

    try {
      assert.equal(canTransitionCatalogStatus('DRAFT', 'PUBLISHED'), true);
      assert.equal(canTransitionCatalogStatus('PUBLISHED', 'DRAFT'), false);
      assert.equal(canTransitionCatalogStatus('ARCHIVED', 'PUBLISHED'), false);

      const family = await database.catalog.createFamily(
        {
          category: 'MASCARA',
          brandName: 'Example Beauty',
          name: 'Decision Mascara',
        },
        allowedProvenance,
      );
      const variantAResult = await database.catalog.createVariant(
        {
          productFamilyId: family.productFamilyId,
          name: 'Black / 10 ml / washable',
          shadeName: 'Black',
          netQuantityValue: '10',
          netQuantityUnit: 'MILLILITER',
          waterproof: false,
        },
        allowedProvenance,
      );
      assert.equal(variantAResult.kind, 'CREATED');
      if (variantAResult.kind !== 'CREATED') throw new Error('unreachable');
      const variantA = variantAResult.variant;

      const variantBResult = await database.catalog.createVariant(
        {
          productFamilyId: family.productFamilyId,
          name: 'Brown / 10 ml / waterproof',
          shadeName: 'Brown',
          netQuantityValue: '10',
          netQuantityUnit: 'MILLILITER',
          waterproof: true,
        },
        unknownProvenance,
      );
      assert.equal(variantBResult.kind, 'CREATED');
      if (variantBResult.kind !== 'CREATED') throw new Error('unreachable');
      const variantB = variantBResult.variant;

      await assert.rejects(
        adminPool.query(
          `
            INSERT INTO wtm_product_variants (
              family_id,
              name,
              provenance_id
            )
            VALUES ($1, 'Wrongly typed identity', $2)
          `,
          [variantA.productVariantId, variantA.provenanceId],
        ),
        /wtm_product_variants_family_id_fkey/,
      );

      const normalized = normalizeGtin('4006381333931');
      assert.equal(normalized.kind, 'VALID');
      if (normalized.kind !== 'VALID') throw new Error('unreachable');

      const attached = await database.catalog.attachBarcode(
        variantA.productVariantId,
        normalized.gtin,
        allowedProvenance,
      );
      assert.equal(attached.kind, 'ATTACHED');
      assert.equal(
        await database.catalog.findPublishedVariantByGtin(
          normalized.gtin.gtin14,
        ),
        null,
      );
      const idempotent = await database.catalog.attachBarcode(
        variantA.productVariantId,
        normalized.gtin,
        allowedProvenance,
      );
      assert.equal(idempotent.kind, 'ALREADY_ATTACHED');
      const conflict = await database.catalog.attachBarcode(
        variantB.productVariantId,
        normalized.gtin,
        unknownProvenance,
      );
      assert.equal(conflict.kind, 'GTIN_CONFLICT');
      if (conflict.kind !== 'GTIN_CONFLICT') throw new Error('unreachable');
      assert.equal(
        conflict.existingProductVariantId,
        variantA.productVariantId,
      );

      const firstFormula = await database.catalog.createFormulaRevision(
        variantA.productVariantId,
        'AQUA, WAX',
        allowedProvenance,
      );
      assert.equal(firstFormula.kind, 'CREATED');
      if (firstFormula.kind !== 'CREATED') throw new Error('unreachable');
      assert.equal(firstFormula.revision.revisionNumber, 1);

      const unchangedFormula = await database.catalog.createFormulaRevision(
        variantA.productVariantId,
        'AQUA, WAX',
        unknownProvenance,
      );
      assert.equal(unchangedFormula.kind, 'UNCHANGED');
      if (unchangedFormula.kind !== 'UNCHANGED') throw new Error('unreachable');
      assert.equal(
        unchangedFormula.revision.formulaRevisionId,
        firstFormula.revision.formulaRevisionId,
      );

      const changedFormula = await database.catalog.createFormulaRevision(
        variantA.productVariantId,
        'AQUA, WAX, CI 77499',
        allowedProvenance,
      );
      assert.equal(changedFormula.kind, 'CREATED');
      if (changedFormula.kind !== 'CREATED') throw new Error('unreachable');
      assert.equal(changedFormula.revision.revisionNumber, 2);

      const otherFormula = await database.catalog.createFormulaRevision(
        variantB.productVariantId,
        'AQUA, PARAFFIN',
        unknownProvenance,
      );
      assert.equal(otherFormula.kind, 'CREATED');
      if (otherFormula.kind !== 'CREATED') throw new Error('unreachable');

      const mismatchedClaim = await database.catalog.createClaim(
        {
          productVariantId: variantA.productVariantId,
          formulaRevisionId: otherFormula.revision.formulaRevisionId,
          kind: 'WATERPROOF',
          text: 'Waterproof wear',
        },
        allowedProvenance,
      );
      assert.equal(mismatchedClaim.kind, 'FORMULA_REVISION_NOT_FOUND');

      const claim = await database.catalog.createClaim(
        {
          productVariantId: variantA.productVariantId,
          formulaRevisionId: changedFormula.revision.formulaRevisionId,
          kind: 'VOLUME',
          text: 'Visible volume',
        },
        allowedProvenance,
      );
      assert.equal(claim.kind, 'CREATED');
      if (claim.kind !== 'CREATED') throw new Error('unreachable');

      assert.deepEqual(
        await database.catalog.transitionVariantStatus(
          variantA.productVariantId,
          'PUBLISHED',
        ),
        { kind: 'PARENT_NOT_PUBLISHED' },
      );
      assert.deepEqual(
        await database.catalog.transitionFamilyStatus(
          family.productFamilyId,
          'PUBLISHED',
        ),
        { kind: 'UPDATED', status: 'PUBLISHED' },
      );
      assert.deepEqual(
        await database.catalog.transitionVariantStatus(
          variantB.productVariantId,
          'PUBLISHED',
        ),
        { kind: 'PROVENANCE_NOT_ALLOWED' },
      );
      assert.deepEqual(
        await database.catalog.transitionVariantStatus(
          variantA.productVariantId,
          'PUBLISHED',
        ),
        { kind: 'UPDATED', status: 'PUBLISHED' },
      );

      await adminPool.query(
        `
          UPDATE wtm_product_claims
          SET status = 'PUBLISHED', published_at = now(), updated_at = now()
          WHERE id = $1
        `,
        [claim.claim.productClaimId],
      );
      const published = await database.catalog.findPublishedVariantByGtin(
        normalized.gtin.gtin14,
      );
      assert.ok(published);
      assert.equal(published.productVariantId, variantA.productVariantId);
      assert.equal(published.productFamilyId, family.productFamilyId);
      assert.equal(published.brandName, 'Example Beauty');
      assert.equal(published.variantName, 'Black / 10 ml / washable');
      assert.equal(published.formula?.revisionNumber, 2);
      assert.equal(published.formula?.inciText, 'AQUA, WAX, CI 77499');
      assert.deepEqual(
        published.claims.map(({ kind, text }) => ({ kind, text })),
        [{ kind: 'VOLUME', text: 'Visible volume' }],
      );
      assert.equal(
        published.identitySources.barcode.sourceKind,
        'MANUFACTURER',
      );

      const unknown = normalizeGtin('5901234123457');
      assert.equal(unknown.kind, 'VALID');
      if (unknown.kind !== 'VALID') throw new Error('unreachable');
      assert.equal(
        await database.catalog.findPublishedVariantByGtin(unknown.gtin.gtin14),
        null,
      );
      assert.deepEqual(
        await database.catalog.transitionFamilyStatus(
          family.productFamilyId,
          'ARCHIVED',
        ),
        { kind: 'ACTIVE_VARIANTS_EXIST' },
      );

      await database.catalog.transitionVariantStatus(
        variantA.productVariantId,
        'ARCHIVED',
      );
      await database.catalog.transitionVariantStatus(
        variantB.productVariantId,
        'ARCHIVED',
      );
      assert.deepEqual(
        await database.catalog.transitionFamilyStatus(
          family.productFamilyId,
          'ARCHIVED',
        ),
        { kind: 'UPDATED', status: 'ARCHIVED' },
      );
      assert.deepEqual(
        await database.catalog.transitionVariantStatus(
          variantA.productVariantId,
          'PUBLISHED',
        ),
        { kind: 'INVALID_TRANSITION' },
      );

      const revisions = await adminPool.query<{
        revision_number: number;
        status: string;
      }>(
        `
          SELECT revision_number, status
          FROM wtm_formula_revisions
          WHERE variant_id = $1
          ORDER BY revision_number
        `,
        [variantA.productVariantId],
      );
      assert.deepEqual(revisions.rows, [
        { revision_number: 1, status: 'SUPERSEDED' },
        { revision_number: 2, status: 'CURRENT' },
      ]);

      const provenanceCount = await adminPool.query<{ count: string }>(
        'SELECT count(*) FROM wtm_catalog_provenance',
      );
      assert.equal(provenanceCount.rows[0]?.count, '8');
    } finally {
      await database.close();
      await adminPool.end();
    }
  },
);
