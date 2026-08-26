import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { createPostgresDatabase } from '@wtm/infrastructure';

import { prepareCatalogImport } from '../src/catalog-import/service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function manifest(options?: {
  datasetVersion?: string;
  rightsStatus?: 'ALLOWED' | 'UNKNOWN';
  products?: unknown[];
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    datasetId: 'fixture-mascara',
    datasetVersion: options?.datasetVersion ?? '1',
    source: {
      label: 'Fixture catalog',
      uri: 'https://fixture.example/catalog',
      licenseName: 'Fixture license',
      licenseUri: 'https://fixture.example/license',
      attribution: 'Fixture data for integration testing.',
      rightsStatus: options?.rightsStatus ?? 'ALLOWED',
      retrievedAt: '2026-08-26T15:00:00.000Z',
    },
    products: options?.products ?? [
      {
        sourceRecordId: 'fixture-1',
        gtin: '4006381333931',
        brandName: 'Fixture Beauty',
        familyName: 'Focus Mascara',
        variantName: 'Black 10 ml',
        shadeName: 'Black',
        netQuantity: { value: '10', unit: 'MILLILITER' },
        isWaterproof: false,
      },
      {
        sourceRecordId: 'fixture-2',
        gtin: '5901234123457',
        brandName: 'Fixture Beauty',
        familyName: 'Volume Mascara',
        variantName: 'Brown',
        shadeName: 'Brown',
        netQuantity: null,
        isWaterproof: null,
      },
      {
        sourceRecordId: 'fixture-invalid-checksum',
        gtin: '4006381333932',
        brandName: 'Fixture Beauty',
        familyName: 'Invalid Mascara',
        variantName: 'Invalid',
        shadeName: null,
        netQuantity: null,
        isWaterproof: null,
      },
    ],
  });
}

test(
  'catalog seed dry-runs, quarantines, replays idempotently, and rolls back',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 4,
      applicationName: 'wtm-catalog-seed-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(`
      TRUNCATE
        wtm_catalog_import_events,
        wtm_catalog_import_items,
        wtm_catalog_import_batches,
        wtm_product_claims,
        wtm_formula_revisions,
        wtm_product_barcodes,
        wtm_product_variants,
        wtm_product_families,
        wtm_catalog_provenance
      CASCADE
    `);

    try {
      const input = prepareCatalogImport(manifest());
      const preview = await database.catalogImports.preview(input);
      assert.equal(preview.kind, 'READY');
      assert.deepEqual(preview.counts, {
        total: 3,
        ready: 2,
        published: 0,
        quarantined: 1,
        conflicts: 0,
        rolledBack: 0,
      });
      assert.equal(preview.quarantine[0]?.code, 'INVALID_GTIN');

      const published = await database.catalogImports.publish(input);
      assert.equal(published.kind, 'PUBLISHED');
      assert.equal(published.counts.published, 2);
      assert.equal(published.counts.quarantined, 1);
      const firstCandidate = input.candidates[0];
      assert.ok(firstCandidate);
      assert.ok(
        await database.catalog.findPublishedVariantByGtin(
          firstCandidate.gtin.gtin14,
        ),
      );

      const replay = await database.catalogImports.publish(input);
      assert.equal(replay.kind, 'ALREADY_PUBLISHED');
      assert.deepEqual(replay.counts, published.counts);

      const versionConflict = await database.catalogImports.publish(
        prepareCatalogImport(
          manifest({
            products: [
              {
                sourceRecordId: 'changed-row',
                gtin: '5012345678900',
                brandName: 'Changed',
                familyName: 'Changed Mascara',
                variantName: 'Changed',
                shadeName: null,
                netQuantity: null,
                isWaterproof: null,
              },
            ],
          }),
        ),
      );
      assert.equal(versionConflict.kind, 'VERSION_CONFLICT');

      const conflictingBatch = await database.catalogImports.publish(
        prepareCatalogImport(
          manifest({
            datasetVersion: '2',
            products: [
              {
                sourceRecordId: 'conflict-row',
                gtin: '4006381333931',
                brandName: 'Other Brand',
                familyName: 'Conflicting Mascara',
                variantName: 'Conflict',
                shadeName: null,
                netQuantity: null,
                isWaterproof: null,
              },
            ],
          }),
        ),
      );
      assert.equal(conflictingBatch.kind, 'QUARANTINED');
      assert.equal(conflictingBatch.quarantine[0]?.code, 'GTIN_CONFLICT');

      const rightsBlocked = await database.catalogImports.publish(
        prepareCatalogImport(
          manifest({
            datasetVersion: '3',
            rightsStatus: 'UNKNOWN',
            products: [
              {
                sourceRecordId: 'unknown-rights-row',
                gtin: '5012345678900',
                brandName: 'Unknown Rights',
                familyName: 'Private Mascara',
                variantName: 'Private',
                shadeName: null,
                netQuantity: null,
                isWaterproof: null,
              },
            ],
          }),
        ),
      );
      assert.equal(rightsBlocked.kind, 'QUARANTINED');
      assert.equal(rightsBlocked.quarantine[0]?.code, 'RIGHTS_NOT_ALLOWED');
      const unknownInput = prepareCatalogImport(
        manifest({
          datasetVersion: '3',
          rightsStatus: 'UNKNOWN',
          products: [
            {
              sourceRecordId: 'unknown-rights-row',
              gtin: '5012345678900',
              brandName: 'Unknown Rights',
              familyName: 'Private Mascara',
              variantName: 'Private',
              shadeName: null,
              netQuantity: null,
              isWaterproof: null,
            },
          ],
        }),
      );
      const unknownCandidate = unknownInput.candidates[0];
      assert.ok(unknownCandidate);
      assert.equal(
        await database.catalog.findPublishedVariantByGtin(
          unknownCandidate.gtin.gtin14,
        ),
        null,
      );

      const rolledBack = await database.catalogImports.rollback(
        input.importKey,
      );
      assert.equal(rolledBack.kind, 'ROLLED_BACK');
      assert.equal(rolledBack.counts.rolledBack, 3);
      for (const candidate of input.candidates) {
        assert.equal(
          await database.catalog.findPublishedVariantByGtin(
            candidate.gtin.gtin14,
          ),
          null,
        );
      }
      assert.equal(
        (await database.catalogImports.rollback(input.importKey)).kind,
        'ALREADY_ROLLED_BACK',
      );

      const audit = await adminPool.query<{ event_kind: string }>(
        `
          SELECT event_kind
          FROM wtm_catalog_import_events
          WHERE batch_id = (
            SELECT id FROM wtm_catalog_import_batches WHERE import_key = $1
          )
          ORDER BY id
        `,
        [input.importKey],
      );
      assert.deepEqual(
        audit.rows.map(({ event_kind }) => event_kind),
        [
          'PUBLISHED',
          'IDEMPOTENT_REPLAY',
          'VERSION_CONFLICT',
          'ROLLED_BACK',
          'ROLLBACK_REPLAY',
        ],
      );
    } finally {
      await database.close();
      await adminPool.end();
    }
  },
);
