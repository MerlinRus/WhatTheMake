import type { Pool, PoolClient } from 'pg';

import type {
  CatalogImportCandidate,
  CatalogImportInput,
  CatalogImportOperation,
  CatalogImportQuarantineRow,
  CatalogImportReport,
  CatalogImportRepository,
  CatalogImportResultKind,
  ProductFamilyId,
  ProductVariantId,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

type BatchStatus = 'PUBLISHED' | 'QUARANTINED' | 'ROLLED_BACK';
type ItemStatus = BatchStatus;

interface BatchRow {
  id: string;
  import_key: string;
  dataset_id: string;
  dataset_version: string;
  manifest_sha256: string;
  status: BatchStatus;
  total_count: number;
  published_count: number;
  quarantined_count: number;
}

interface ItemRow {
  row_number: number;
  source_record_id: string | null;
  row_sha256: string;
  input_gtin: string | null;
  status: ItemStatus;
  quarantine_code: CatalogImportQuarantineRow['code'] | null;
  product_family_id: string | null;
  product_variant_id: string | null;
  provenance_id: string | null;
  gtin14: string | null;
}

interface PublishedItem {
  candidate: CatalogImportCandidate;
  productFamilyId: ProductFamilyId;
  productVariantId: ProductVariantId;
  provenanceId: string;
}

const batchColumns = `
  id,
  import_key,
  dataset_id,
  dataset_version,
  manifest_sha256,
  status,
  total_count,
  published_count,
  quarantined_count
`;

const itemColumns = `
  row_number,
  source_record_id,
  row_sha256,
  input_gtin,
  status,
  quarantine_code,
  product_family_id,
  product_variant_id,
  provenance_id,
  gtin14
`;

function assertCanonicalImportKey(input: CatalogImportInput): void {
  if (input.importKey !== `${input.datasetId}@${input.datasetVersion}`) {
    throw new Error('Catalog import key is not canonical');
  }
  if (
    input.totalRows !==
    input.candidates.length + input.quarantinedRows.length
  ) {
    throw new Error('Catalog import row counts do not match');
  }
}

function emptyReport(
  operation: CatalogImportOperation,
  kind: CatalogImportResultKind,
  importKey: string,
  manifestSha256: string | null,
): CatalogImportReport {
  return {
    schemaVersion: 1,
    operation,
    kind,
    importKey,
    manifestSha256,
    counts: {
      total: 0,
      ready: 0,
      published: 0,
      quarantined: 0,
      conflicts: 0,
      rolledBack: 0,
    },
    quarantine: [],
  };
}

function quarantineSort(
  rows: CatalogImportQuarantineRow[],
): CatalogImportQuarantineRow[] {
  return rows.toSorted((left, right) => left.rowNumber - right.rowNumber);
}

function previewReport(
  input: CatalogImportInput,
  kind: 'READY' | 'QUARANTINED' | 'VERSION_CONFLICT',
  readyCount: number,
  quarantine: CatalogImportQuarantineRow[],
): CatalogImportReport {
  const sorted = quarantineSort(quarantine);
  return {
    schemaVersion: 1,
    operation: 'DRY_RUN',
    kind,
    importKey: input.importKey,
    manifestSha256: input.manifestSha256,
    counts: {
      total: input.totalRows,
      ready: readyCount,
      published: 0,
      quarantined: sorted.length,
      conflicts: sorted.filter(({ code }) => code === 'GTIN_CONFLICT').length,
      rolledBack: 0,
    },
    quarantine: sorted,
  };
}

function storedReport(
  operation: CatalogImportOperation,
  kind: CatalogImportResultKind,
  batch: BatchRow,
  items: ItemRow[],
): CatalogImportReport {
  const quarantinedItems = items.filter(
    ({ status, quarantine_code }) =>
      status === 'QUARANTINED' && quarantine_code !== null,
  );
  return {
    schemaVersion: 1,
    operation,
    kind,
    importKey: batch.import_key,
    manifestSha256: batch.manifest_sha256,
    counts: {
      total: batch.total_count,
      ready: 0,
      published: items.filter(({ status }) => status === 'PUBLISHED').length,
      quarantined: quarantinedItems.length,
      conflicts: quarantinedItems.filter(
        ({ quarantine_code }) => quarantine_code === 'GTIN_CONFLICT',
      ).length,
      rolledBack: items.filter(({ status }) => status === 'ROLLED_BACK').length,
    },
    quarantine: quarantinedItems.map((row) => ({
      rowNumber: row.row_number,
      sourceRecordId: row.source_record_id,
      gtin: row.input_gtin,
      rowSha256: row.row_sha256,
      code: row.quarantine_code ?? 'INVALID_ROW',
    })),
  };
}

async function findBatch(
  client: PoolClient,
  input: CatalogImportInput,
  forUpdate: boolean,
): Promise<BatchRow | null> {
  const selected = await client.query<BatchRow>(
    `
      SELECT ${batchColumns}
      FROM wtm_catalog_import_batches
      WHERE import_key = $1
         OR (dataset_id = $2 AND dataset_version = $3)
      ORDER BY (import_key = $1) DESC
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [input.importKey, input.datasetId, input.datasetVersion],
  );
  return selected.rows[0] ?? null;
}

async function loadItems(
  client: PoolClient,
  batchId: string,
  forUpdate = false,
): Promise<ItemRow[]> {
  const selected = await client.query<ItemRow>(
    `
      SELECT ${itemColumns}
      FROM wtm_catalog_import_items
      WHERE batch_id = $1
      ORDER BY row_number
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [batchId],
  );
  return selected.rows;
}

function replayKind(status: BatchStatus): CatalogImportResultKind {
  switch (status) {
    case 'PUBLISHED':
      return 'ALREADY_PUBLISHED';
    case 'QUARANTINED':
      return 'ALREADY_QUARANTINED';
    case 'ROLLED_BACK':
      return 'ALREADY_ROLLED_BACK';
  }
}

async function appendEvent(
  client: PoolClient,
  batchId: string,
  eventKind:
    | 'PUBLISHED'
    | 'QUARANTINED'
    | 'IDEMPOTENT_REPLAY'
    | 'VERSION_CONFLICT'
    | 'ROLLED_BACK'
    | 'ROLLBACK_REPLAY'
    | 'ROLLBACK_CONFLICT',
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `
      INSERT INTO wtm_catalog_import_events (batch_id, event_kind, details)
      VALUES ($1, $2, $3::jsonb)
    `,
    [batchId, eventKind, JSON.stringify(details)],
  );
}

function rightsQuarantine(
  candidate: CatalogImportCandidate,
): CatalogImportQuarantineRow {
  return {
    rowNumber: candidate.rowNumber,
    sourceRecordId: candidate.sourceRecordId,
    gtin: candidate.gtin.value,
    rowSha256: candidate.rowSha256,
    code: 'RIGHTS_NOT_ALLOWED',
  };
}

function conflictQuarantine(
  candidate: CatalogImportCandidate,
): CatalogImportQuarantineRow {
  return {
    rowNumber: candidate.rowNumber,
    sourceRecordId: candidate.sourceRecordId,
    gtin: candidate.gtin.value,
    rowSha256: candidate.rowSha256,
    code: 'GTIN_CONFLICT',
  };
}

async function previewNewImport(
  client: PoolClient,
  input: CatalogImportInput,
): Promise<CatalogImportReport> {
  if (input.source.rightsStatus !== 'ALLOWED') {
    return previewReport(input, 'QUARANTINED', 0, [
      ...input.quarantinedRows,
      ...input.candidates.map(rightsQuarantine),
    ]);
  }

  const gtin14s = input.candidates.map(({ gtin }) => gtin.gtin14);
  const conflicts =
    gtin14s.length === 0
      ? new Set<string>()
      : new Set(
          (
            await client.query<{ gtin14: string }>(
              `
                SELECT gtin14
                FROM wtm_product_barcodes
                WHERE gtin14::text = ANY($1::text[])
              `,
              [gtin14s],
            )
          ).rows.map(({ gtin14 }) => gtin14),
        );
  const conflictRows = input.candidates
    .filter(({ gtin }) => conflicts.has(gtin.gtin14))
    .map(conflictQuarantine);
  const readyCount = input.candidates.length - conflictRows.length;
  return previewReport(
    input,
    readyCount > 0 ? 'READY' : 'QUARANTINED',
    readyCount,
    [...input.quarantinedRows, ...conflictRows],
  );
}

async function publishCandidate(
  client: PoolClient,
  input: CatalogImportInput,
  candidate: CatalogImportCandidate,
): Promise<PublishedItem | CatalogImportQuarantineRow> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    candidate.gtin.gtin14,
  ]);
  const existing = await client.query(
    'SELECT 1 FROM wtm_product_barcodes WHERE gtin14 = $1',
    [candidate.gtin.gtin14],
  );
  if (existing.rowCount === 1) return conflictQuarantine(candidate);

  const provenance = await client.query<{ id: string }>(
    `
      INSERT INTO wtm_catalog_provenance (
        source_kind,
        source_label,
        source_uri,
        source_record_id,
        observed_at,
        rights_status
      )
      VALUES ('CONTROLLED_IMPORT', $1, $2, $3, $4, 'ALLOWED')
      RETURNING id
    `,
    [
      input.source.label,
      input.source.uri,
      candidate.sourceRecordId,
      input.source.retrievedAt,
    ],
  );
  const provenanceId = provenance.rows[0]?.id;
  if (!provenanceId)
    throw new Error('Import provenance insert returned no row');

  const family = await client.query<{ id: string }>(
    `
      INSERT INTO wtm_product_families (
        category,
        brand_name,
        name,
        status,
        provenance_id,
        published_at
      )
      VALUES ('MASCARA', $1, $2, 'PUBLISHED', $3, now())
      RETURNING id
    `,
    [candidate.brandName, candidate.familyName, provenanceId],
  );
  const productFamilyId = family.rows[0]?.id as ProductFamilyId | undefined;
  if (!productFamilyId) throw new Error('Import family insert returned no row');

  const variant = await client.query<{ id: string }>(
    `
      INSERT INTO wtm_product_variants (
        family_id,
        name,
        shade_name,
        net_quantity_value,
        net_quantity_unit,
        waterproof,
        status,
        provenance_id,
        published_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PUBLISHED', $7, now())
      RETURNING id
    `,
    [
      productFamilyId,
      candidate.variantName,
      candidate.shadeName,
      candidate.netQuantityValue,
      candidate.netQuantityUnit,
      candidate.isWaterproof,
      provenanceId,
    ],
  );
  const productVariantId = variant.rows[0]?.id as ProductVariantId | undefined;
  if (!productVariantId)
    throw new Error('Import variant insert returned no row');

  await client.query(
    `
      INSERT INTO wtm_product_barcodes (
        gtin14,
        source_value,
        format,
        variant_id,
        provenance_id
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      candidate.gtin.gtin14,
      candidate.gtin.value,
      candidate.gtin.format,
      productVariantId,
      provenanceId,
    ],
  );

  return {
    candidate,
    productFamilyId,
    productVariantId,
    provenanceId,
  };
}

async function insertBatch(
  client: PoolClient,
  input: CatalogImportInput,
  status: Exclude<BatchStatus, 'ROLLED_BACK'>,
  publishedCount: number,
  quarantinedCount: number,
): Promise<BatchRow> {
  const inserted = await client.query<BatchRow>(
    `
      INSERT INTO wtm_catalog_import_batches (
        import_key,
        dataset_id,
        dataset_version,
        manifest_sha256,
        source_label,
        source_uri,
        source_license_name,
        source_license_uri,
        source_attribution,
        source_rights_status,
        source_retrieved_at,
        status,
        total_count,
        published_count,
        quarantined_count,
        published_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        CASE WHEN $12 = 'PUBLISHED' THEN now() ELSE NULL END
      )
      RETURNING ${batchColumns}
    `,
    [
      input.importKey,
      input.datasetId,
      input.datasetVersion,
      input.manifestSha256,
      input.source.label,
      input.source.uri,
      input.source.licenseName,
      input.source.licenseUri,
      input.source.attribution,
      input.source.rightsStatus,
      input.source.retrievedAt,
      status,
      input.totalRows,
      publishedCount,
      quarantinedCount,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('Catalog import batch insert returned no row');
  return row;
}

async function insertPublishedItem(
  client: PoolClient,
  batchId: string,
  item: PublishedItem,
): Promise<void> {
  const { candidate } = item;
  await client.query(
    `
      INSERT INTO wtm_catalog_import_items (
        batch_id,
        row_number,
        source_record_id,
        row_sha256,
        input_gtin,
        gtin14,
        source_value,
        format,
        status,
        product_family_id,
        product_variant_id,
        provenance_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PUBLISHED', $9, $10, $11)
    `,
    [
      batchId,
      candidate.rowNumber,
      candidate.sourceRecordId,
      candidate.rowSha256,
      candidate.gtin.value,
      candidate.gtin.gtin14,
      candidate.gtin.value,
      candidate.gtin.format,
      item.productFamilyId,
      item.productVariantId,
      item.provenanceId,
    ],
  );
}

async function insertQuarantinedItem(
  client: PoolClient,
  batchId: string,
  row: CatalogImportQuarantineRow,
): Promise<void> {
  await client.query(
    `
      INSERT INTO wtm_catalog_import_items (
        batch_id,
        row_number,
        source_record_id,
        row_sha256,
        input_gtin,
        status,
        quarantine_code
      )
      VALUES ($1, $2, $3, $4, $5, 'QUARANTINED', $6)
    `,
    [
      batchId,
      row.rowNumber,
      row.sourceRecordId,
      row.rowSha256,
      row.gtin,
      row.code,
    ],
  );
}

async function hasRollbackDrift(
  client: PoolClient,
  item: ItemRow,
): Promise<boolean> {
  if (
    item.product_family_id === null ||
    item.product_variant_id === null ||
    item.provenance_id === null ||
    item.gtin14 === null
  ) {
    return true;
  }
  const selected = await client.query<{
    variant_status: string;
    family_status: string;
    barcode_matches: boolean;
    other_active_variants: boolean;
  }>(
    `
      SELECT
        variant.status AS variant_status,
        family.status AS family_status,
        EXISTS (
          SELECT 1
          FROM wtm_product_barcodes AS barcode
          WHERE barcode.gtin14 = $3
            AND barcode.variant_id = variant.id
            AND barcode.provenance_id = $4
        ) AS barcode_matches,
        EXISTS (
          SELECT 1
          FROM wtm_product_variants AS other_variant
          WHERE other_variant.family_id = family.id
            AND other_variant.id <> variant.id
            AND other_variant.status <> 'ARCHIVED'
        ) AS other_active_variants
      FROM wtm_product_variants AS variant
      JOIN wtm_product_families AS family ON family.id = variant.family_id
      WHERE variant.id = $1
        AND family.id = $2
        AND variant.provenance_id = $4
        AND family.provenance_id = $4
      FOR UPDATE OF variant, family
    `,
    [
      item.product_variant_id,
      item.product_family_id,
      item.gtin14,
      item.provenance_id,
    ],
  );
  const row = selected.rows[0];
  return (
    !row ||
    row.variant_status !== 'PUBLISHED' ||
    row.family_status !== 'PUBLISHED' ||
    !row.barcode_matches ||
    row.other_active_variants
  );
}

export function createPostgresCatalogImportRepository(
  pool: Pool,
): CatalogImportRepository {
  return {
    async preview(input) {
      assertCanonicalImportKey(input);
      return withTransaction(pool, async (client) => {
        await client.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        const existing = await findBatch(client, input, false);
        if (!existing) return previewNewImport(client, input);
        if (existing.manifest_sha256 !== input.manifestSha256) {
          return previewReport(input, 'VERSION_CONFLICT', 0, [
            ...input.quarantinedRows,
          ]);
        }
        return storedReport(
          'DRY_RUN',
          replayKind(existing.status),
          existing,
          await loadItems(client, existing.id),
        );
      });
    },

    async publish(input) {
      assertCanonicalImportKey(input);
      return withTransaction(pool, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 17))',
          [input.importKey],
        );
        const existing = await findBatch(client, input, true);
        if (existing) {
          if (existing.manifest_sha256 !== input.manifestSha256) {
            await appendEvent(client, existing.id, 'VERSION_CONFLICT', {
              attemptedManifestSha256: input.manifestSha256,
            });
            const report = previewReport(input, 'VERSION_CONFLICT', 0, [
              ...input.quarantinedRows,
            ]);
            return { ...report, operation: 'PUBLISH' };
          }
          await appendEvent(client, existing.id, 'IDEMPOTENT_REPLAY', {
            status: existing.status,
          });
          return storedReport(
            'PUBLISH',
            replayKind(existing.status),
            existing,
            await loadItems(client, existing.id),
          );
        }

        const published: PublishedItem[] = [];
        const quarantine = [...input.quarantinedRows];
        if (input.source.rightsStatus !== 'ALLOWED') {
          quarantine.push(...input.candidates.map(rightsQuarantine));
        } else {
          for (const candidate of input.candidates.toSorted((left, right) =>
            left.gtin.gtin14.localeCompare(right.gtin.gtin14),
          )) {
            const result = await publishCandidate(client, input, candidate);
            if ('code' in result) quarantine.push(result);
            else published.push(result);
          }
        }

        const status = published.length > 0 ? 'PUBLISHED' : 'QUARANTINED';
        const batch = await insertBatch(
          client,
          input,
          status,
          published.length,
          quarantine.length,
        );
        for (const item of published) {
          await insertPublishedItem(client, batch.id, item);
        }
        for (const row of quarantineSort(quarantine)) {
          await insertQuarantinedItem(client, batch.id, row);
        }
        const items = await loadItems(client, batch.id);
        const kind = status === 'PUBLISHED' ? 'PUBLISHED' : 'QUARANTINED';
        const report = storedReport('PUBLISH', kind, batch, items);
        await appendEvent(client, batch.id, kind, {
          manifestSha256: input.manifestSha256,
          counts: report.counts,
        });
        return report;
      });
    },

    async rollback(importKey) {
      return withTransaction(pool, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 17))',
          [importKey],
        );
        const selected = await client.query<BatchRow>(
          `
            SELECT ${batchColumns}
            FROM wtm_catalog_import_batches
            WHERE import_key = $1
            FOR UPDATE
          `,
          [importKey],
        );
        const batch = selected.rows[0];
        if (!batch)
          return emptyReport('ROLLBACK', 'NOT_FOUND', importKey, null);

        const items = await loadItems(client, batch.id, true);
        if (batch.status === 'ROLLED_BACK') {
          await appendEvent(client, batch.id, 'ROLLBACK_REPLAY', {});
          return storedReport('ROLLBACK', 'ALREADY_ROLLED_BACK', batch, items);
        }

        const publishedItems = items.filter(
          ({ status }) => status === 'PUBLISHED',
        );
        for (const item of publishedItems.toSorted((left, right) =>
          (left.gtin14 ?? '').localeCompare(right.gtin14 ?? ''),
        )) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [item.gtin14],
          );
        }
        const driftedRows: number[] = [];
        for (const item of publishedItems) {
          if (await hasRollbackDrift(client, item)) {
            driftedRows.push(item.row_number);
          }
        }
        if (driftedRows.length > 0) {
          await appendEvent(client, batch.id, 'ROLLBACK_CONFLICT', {
            driftedRows,
          });
          return storedReport('ROLLBACK', 'ROLLBACK_CONFLICT', batch, items);
        }

        for (const item of publishedItems) {
          await client.query(
            `
              DELETE FROM wtm_product_barcodes
              WHERE gtin14 = $1 AND variant_id = $2
            `,
            [item.gtin14, item.product_variant_id],
          );
          await client.query(
            `
              UPDATE wtm_product_variants
              SET status = 'ARCHIVED', updated_at = now(), archived_at = now()
              WHERE id = $1
            `,
            [item.product_variant_id],
          );
          await client.query(
            `
              UPDATE wtm_product_families
              SET status = 'ARCHIVED', updated_at = now(), archived_at = now()
              WHERE id = $1
            `,
            [item.product_family_id],
          );
        }
        await client.query(
          `
            UPDATE wtm_catalog_import_items
            SET status = 'ROLLED_BACK', rolled_back_at = now()
            WHERE batch_id = $1
          `,
          [batch.id],
        );
        const updatedBatch = (
          await client.query<BatchRow>(
            `
              UPDATE wtm_catalog_import_batches
              SET status = 'ROLLED_BACK', rolled_back_at = now()
              WHERE id = $1
              RETURNING ${batchColumns}
            `,
            [batch.id],
          )
        ).rows[0];
        if (!updatedBatch)
          throw new Error('Catalog import rollback lost batch');
        const updatedItems = await loadItems(client, batch.id);
        const report = storedReport(
          'ROLLBACK',
          'ROLLED_BACK',
          updatedBatch,
          updatedItems,
        );
        await appendEvent(client, batch.id, 'ROLLED_BACK', {
          counts: report.counts,
        });
        return report;
      });
    },
  };
}
