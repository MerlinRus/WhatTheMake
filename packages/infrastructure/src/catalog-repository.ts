import type { Pool, PoolClient } from 'pg';

import {
  canTransitionCatalogStatus,
  type CatalogProvenanceId,
  type CatalogProvenanceInput,
  type CatalogRepository,
  type CatalogRightsStatus,
  type CatalogStatus,
  type FormulaRevision,
  type FormulaRevisionId,
  type FormulaRevisionStatus,
  type NetQuantityUnit,
  type ProductCategory,
  type ProductClaim,
  type ProductClaimId,
  type ProductClaimKind,
  type ProductClaimStatus,
  type ProductFamily,
  type ProductFamilyId,
  type ProductVariant,
  type ProductVariantId,
  type PublishedCatalogClaim,
  type PublishedCatalogFormula,
  type PublishedCatalogSource,
  type PublishedCatalogVariant,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

interface ProductFamilyRow {
  id: string;
  category: ProductCategory;
  brand_name: string;
  name: string;
  status: CatalogStatus;
  provenance_id: string;
  created_at: Date;
  updated_at: Date;
}

interface ProductVariantRow {
  id: string;
  family_id: string;
  name: string;
  shade_name: string | null;
  net_quantity_value: string | null;
  net_quantity_unit: NetQuantityUnit | null;
  waterproof: boolean | null;
  status: CatalogStatus;
  provenance_id: string;
  created_at: Date;
  updated_at: Date;
}

interface FormulaRevisionRow {
  id: string;
  variant_id: string;
  revision_number: number;
  inci_text: string;
  status: FormulaRevisionStatus;
  provenance_id: string;
  created_at: Date;
  superseded_at: Date | null;
}

interface ProductClaimRow {
  id: string;
  variant_id: string;
  formula_revision_id: string | null;
  claim_kind: ProductClaimKind;
  claim_text: string;
  status: ProductClaimStatus;
  provenance_id: string;
  created_at: Date;
  updated_at: Date;
}

interface StatusRow {
  status: CatalogStatus;
  rights_status: CatalogRightsStatus;
}

interface PublishedVariantRow {
  product_variant_id: string;
  product_family_id: string;
  category: ProductCategory;
  brand_name: string;
  family_name: string;
  variant_name: string;
  shade_name: string | null;
  net_quantity_value: string | null;
  net_quantity_unit: NetQuantityUnit | null;
  waterproof: boolean | null;
  family_provenance_id: string;
  variant_provenance_id: string;
  barcode_provenance_id: string;
}

interface PublishedSourceFields {
  source_kind: PublishedCatalogSource['sourceKind'];
  source_label: string;
  source_uri: string | null;
  observed_at: Date | null;
  imported_at: Date;
}

interface PublishedSourceRow extends PublishedSourceFields {
  id: string;
}

interface PublishedFormulaRow extends PublishedSourceFields {
  formula_revision_id: string;
  revision_number: number;
  inci_text: string;
}

interface PublishedClaimRow extends PublishedSourceFields {
  product_claim_id: string;
  claim_kind: ProductClaimKind;
  claim_text: string;
}

function productFamily(row: ProductFamilyRow): ProductFamily {
  return {
    productFamilyId: row.id as ProductFamilyId,
    category: row.category,
    brandName: row.brand_name,
    name: row.name,
    status: row.status,
    provenanceId: row.provenance_id as CatalogProvenanceId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function productVariant(row: ProductVariantRow): ProductVariant {
  return {
    productVariantId: row.id as ProductVariantId,
    productFamilyId: row.family_id as ProductFamilyId,
    name: row.name,
    shadeName: row.shade_name,
    netQuantityValue: row.net_quantity_value,
    netQuantityUnit: row.net_quantity_unit,
    waterproof: row.waterproof,
    status: row.status,
    provenanceId: row.provenance_id as CatalogProvenanceId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formulaRevision(row: FormulaRevisionRow): FormulaRevision {
  return {
    formulaRevisionId: row.id as FormulaRevisionId,
    productVariantId: row.variant_id as ProductVariantId,
    revisionNumber: row.revision_number,
    inciText: row.inci_text,
    status: row.status,
    provenanceId: row.provenance_id as CatalogProvenanceId,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

function productClaim(row: ProductClaimRow): ProductClaim {
  return {
    productClaimId: row.id as ProductClaimId,
    productVariantId: row.variant_id as ProductVariantId,
    formulaRevisionId:
      row.formula_revision_id === null
        ? null
        : (row.formula_revision_id as FormulaRevisionId),
    kind: row.claim_kind,
    text: row.claim_text,
    status: row.status,
    provenanceId: row.provenance_id as CatalogProvenanceId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publishedSource(row: PublishedSourceFields): PublishedCatalogSource {
  return {
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    sourceUri: row.source_uri,
    observedAt: row.observed_at,
    importedAt: row.imported_at,
  };
}

function requiredPublishedSource(
  sources: ReadonlyMap<string, PublishedCatalogSource>,
  provenanceId: string,
): PublishedCatalogSource {
  const source = sources.get(provenanceId);
  if (!source) throw new Error('Published catalog source is missing');
  return source;
}

async function insertProvenance(
  client: PoolClient,
  provenance: CatalogProvenanceInput,
): Promise<CatalogProvenanceId> {
  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO wtm_catalog_provenance (
        source_kind,
        source_label,
        source_uri,
        source_record_id,
        observed_at,
        rights_status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      provenance.sourceKind,
      provenance.sourceLabel,
      provenance.sourceUri,
      provenance.sourceRecordId,
      provenance.observedAt,
      provenance.rightsStatus,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('Catalog provenance insert returned no row');
  return row.id as CatalogProvenanceId;
}

const familyColumns = `
  id,
  category,
  brand_name,
  name,
  status,
  provenance_id,
  created_at,
  updated_at
`;

const variantColumns = `
  id,
  family_id,
  name,
  shade_name,
  net_quantity_value,
  net_quantity_unit,
  waterproof,
  status,
  provenance_id,
  created_at,
  updated_at
`;

const formulaColumns = `
  id,
  variant_id,
  revision_number,
  inci_text,
  status,
  provenance_id,
  created_at,
  superseded_at
`;

const claimColumns = `
  id,
  variant_id,
  formula_revision_id,
  claim_kind,
  claim_text,
  status,
  provenance_id,
  created_at,
  updated_at
`;

export function createPostgresCatalogRepository(pool: Pool): CatalogRepository {
  return {
    async findPublishedVariantByGtin(gtin14) {
      return withTransaction(pool, async (client) => {
        await client.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        const selected = await client.query<PublishedVariantRow>(
          `
            SELECT
              variant.id AS product_variant_id,
              family.id AS product_family_id,
              family.category,
              family.brand_name,
              family.name AS family_name,
              variant.name AS variant_name,
              variant.shade_name,
              variant.net_quantity_value,
              variant.net_quantity_unit,
              variant.waterproof,
              family.provenance_id AS family_provenance_id,
              variant.provenance_id AS variant_provenance_id,
              barcode.provenance_id AS barcode_provenance_id
            FROM wtm_product_barcodes AS barcode
            JOIN wtm_product_variants AS variant ON variant.id = barcode.variant_id
            JOIN wtm_product_families AS family ON family.id = variant.family_id
            JOIN wtm_catalog_provenance AS family_source
              ON family_source.id = family.provenance_id
            JOIN wtm_catalog_provenance AS variant_source
              ON variant_source.id = variant.provenance_id
            JOIN wtm_catalog_provenance AS barcode_source
              ON barcode_source.id = barcode.provenance_id
            WHERE
              barcode.gtin14 = $1
              AND family.status = 'PUBLISHED'
              AND variant.status = 'PUBLISHED'
              AND family_source.rights_status = 'ALLOWED'
              AND variant_source.rights_status = 'ALLOWED'
              AND barcode_source.rights_status = 'ALLOWED'
          `,
          [gtin14],
        );
        const row = selected.rows[0];
        if (!row) return null;

        const identitySourceRows = await client.query<PublishedSourceRow>(
          `
            SELECT
              id,
              source_kind,
              source_label,
              source_uri,
              observed_at,
              imported_at
            FROM wtm_catalog_provenance
            WHERE id = ANY($1::uuid[]) AND rights_status = 'ALLOWED'
          `,
          [
            [
              row.family_provenance_id,
              row.variant_provenance_id,
              row.barcode_provenance_id,
            ],
          ],
        );
        const identitySources = new Map(
          identitySourceRows.rows.map((sourceRow) => [
            sourceRow.id,
            publishedSource(sourceRow),
          ]),
        );

        const formulaRows = await client.query<PublishedFormulaRow>(
          `
            SELECT
              formula.id AS formula_revision_id,
              formula.revision_number,
              formula.inci_text,
              source.source_kind,
              source.source_label,
              source.source_uri,
              source.observed_at,
              source.imported_at
            FROM wtm_formula_revisions AS formula
            JOIN wtm_catalog_provenance AS source
              ON source.id = formula.provenance_id
            WHERE
              formula.variant_id = $1
              AND formula.status = 'CURRENT'
              AND source.rights_status = 'ALLOWED'
            LIMIT 1
          `,
          [row.product_variant_id],
        );
        const formulaRow = formulaRows.rows[0];
        const formula: PublishedCatalogFormula | null = formulaRow
          ? {
              formulaRevisionId:
                formulaRow.formula_revision_id as FormulaRevisionId,
              revisionNumber: formulaRow.revision_number,
              inciText: formulaRow.inci_text,
              source: publishedSource(formulaRow),
            }
          : null;

        const claimRows = await client.query<PublishedClaimRow>(
          `
            SELECT
              claim.id AS product_claim_id,
              claim.claim_kind,
              claim.claim_text,
              source.source_kind,
              source.source_label,
              source.source_uri,
              source.observed_at,
              source.imported_at
            FROM wtm_product_claims AS claim
            JOIN wtm_catalog_provenance AS source
              ON source.id = claim.provenance_id
            WHERE
              claim.variant_id = $1
              AND claim.status = 'PUBLISHED'
              AND source.rights_status = 'ALLOWED'
              AND (
                claim.formula_revision_id IS NULL
                OR claim.formula_revision_id = $2
              )
            ORDER BY claim.claim_kind, claim.id
            LIMIT 64
          `,
          [row.product_variant_id, formula?.formulaRevisionId ?? null],
        );
        const claims: PublishedCatalogClaim[] = claimRows.rows.map(
          (claimRow) => ({
            productClaimId: claimRow.product_claim_id as ProductClaimId,
            kind: claimRow.claim_kind,
            text: claimRow.claim_text,
            source: publishedSource(claimRow),
          }),
        );

        const result: PublishedCatalogVariant = {
          productVariantId: row.product_variant_id as ProductVariantId,
          productFamilyId: row.product_family_id as ProductFamilyId,
          category: row.category,
          brandName: row.brand_name,
          familyName: row.family_name,
          variantName: row.variant_name,
          shadeName: row.shade_name,
          netQuantityValue: row.net_quantity_value,
          netQuantityUnit: row.net_quantity_unit,
          waterproof: row.waterproof,
          formula,
          claims,
          identitySources: {
            family: requiredPublishedSource(
              identitySources,
              row.family_provenance_id,
            ),
            variant: requiredPublishedSource(
              identitySources,
              row.variant_provenance_id,
            ),
            barcode: requiredPublishedSource(
              identitySources,
              row.barcode_provenance_id,
            ),
          },
        };
        return result;
      });
    },

    async createFamily(input, provenance): Promise<ProductFamily> {
      return withTransaction(pool, async (client) => {
        const provenanceId = await insertProvenance(client, provenance);
        const inserted = await client.query<ProductFamilyRow>(
          `
            INSERT INTO wtm_product_families (
              category,
              brand_name,
              name,
              provenance_id
            )
            VALUES ($1, $2, $3, $4)
            RETURNING ${familyColumns}
          `,
          [input.category, input.brandName, input.name, provenanceId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Product family insert returned no row');
        return productFamily(row);
      });
    },

    async createVariant(input, provenance) {
      return withTransaction(pool, async (client) => {
        const family = await client.query<{ status: CatalogStatus }>(
          `
            SELECT status
            FROM wtm_product_families
            WHERE id = $1
            FOR UPDATE
          `,
          [input.productFamilyId],
        );
        const familyRow = family.rows[0];
        if (!familyRow) return { kind: 'FAMILY_NOT_FOUND' };
        if (familyRow.status === 'ARCHIVED') {
          return { kind: 'FAMILY_NOT_EDITABLE' };
        }

        const provenanceId = await insertProvenance(client, provenance);
        const inserted = await client.query<ProductVariantRow>(
          `
            INSERT INTO wtm_product_variants (
              family_id,
              name,
              shade_name,
              net_quantity_value,
              net_quantity_unit,
              waterproof,
              provenance_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING ${variantColumns}
          `,
          [
            input.productFamilyId,
            input.name,
            input.shadeName,
            input.netQuantityValue,
            input.netQuantityUnit,
            input.waterproof,
            provenanceId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Product variant insert returned no row');
        return { kind: 'CREATED', variant: productVariant(row) };
      });
    },

    async attachBarcode(productVariantId, gtin, provenance) {
      return withTransaction(pool, async (client) => {
        const variant = await client.query<{ status: CatalogStatus }>(
          `
            SELECT status
            FROM wtm_product_variants
            WHERE id = $1
            FOR UPDATE
          `,
          [productVariantId],
        );
        const variantRow = variant.rows[0];
        if (!variantRow) return { kind: 'VARIANT_NOT_FOUND' };
        if (variantRow.status === 'ARCHIVED') {
          return { kind: 'VARIANT_NOT_EDITABLE' };
        }

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [gtin.gtin14],
        );
        const existing = await client.query<{ variant_id: string }>(
          `
            SELECT variant_id
            FROM wtm_product_barcodes
            WHERE gtin14 = $1
          `,
          [gtin.gtin14],
        );
        const existingRow = existing.rows[0];
        if (existingRow) {
          const existingProductVariantId =
            existingRow.variant_id as ProductVariantId;
          if (existingProductVariantId === productVariantId) {
            return {
              kind: 'ALREADY_ATTACHED',
              productVariantId,
              gtin,
            };
          }
          return {
            kind: 'GTIN_CONFLICT',
            productVariantId,
            existingProductVariantId,
            gtin,
          };
        }

        const provenanceId = await insertProvenance(client, provenance);
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
            gtin.gtin14,
            gtin.value,
            gtin.format,
            productVariantId,
            provenanceId,
          ],
        );
        return { kind: 'ATTACHED', productVariantId, gtin };
      });
    },

    async createFormulaRevision(productVariantId, inciText, provenance) {
      return withTransaction(pool, async (client) => {
        const variant = await client.query<{ status: CatalogStatus }>(
          `
            SELECT status
            FROM wtm_product_variants
            WHERE id = $1
            FOR UPDATE
          `,
          [productVariantId],
        );
        const variantRow = variant.rows[0];
        if (!variantRow) return { kind: 'VARIANT_NOT_FOUND' };
        if (variantRow.status === 'ARCHIVED') {
          return { kind: 'VARIANT_NOT_EDITABLE' };
        }

        const current = await client.query<FormulaRevisionRow>(
          `
            SELECT ${formulaColumns}
            FROM wtm_formula_revisions
            WHERE variant_id = $1 AND status = 'CURRENT'
            FOR UPDATE
          `,
          [productVariantId],
        );
        const currentRow = current.rows[0];
        if (currentRow?.inci_text === inciText) {
          return { kind: 'UNCHANGED', revision: formulaRevision(currentRow) };
        }

        if (currentRow) {
          await client.query(
            `
              UPDATE wtm_formula_revisions
              SET status = 'SUPERSEDED', superseded_at = now()
              WHERE id = $1
            `,
            [currentRow.id],
          );
        }

        const revisionNumber = await client.query<{ next_number: number }>(
          `
            SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_number
            FROM wtm_formula_revisions
            WHERE variant_id = $1
          `,
          [productVariantId],
        );
        const nextNumber = revisionNumber.rows[0]?.next_number;
        if (nextNumber === undefined) {
          throw new Error('Formula revision number query returned no row');
        }

        const provenanceId = await insertProvenance(client, provenance);
        const inserted = await client.query<FormulaRevisionRow>(
          `
            INSERT INTO wtm_formula_revisions (
              variant_id,
              revision_number,
              inci_text,
              provenance_id
            )
            VALUES ($1, $2, $3, $4)
            RETURNING ${formulaColumns}
          `,
          [productVariantId, nextNumber, inciText, provenanceId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Formula revision insert returned no row');
        return { kind: 'CREATED', revision: formulaRevision(row) };
      });
    },

    async createClaim(input, provenance) {
      return withTransaction(pool, async (client) => {
        const variant = await client.query<{ status: CatalogStatus }>(
          `
            SELECT status
            FROM wtm_product_variants
            WHERE id = $1
            FOR UPDATE
          `,
          [input.productVariantId],
        );
        const variantRow = variant.rows[0];
        if (!variantRow) return { kind: 'VARIANT_NOT_FOUND' };
        if (variantRow.status === 'ARCHIVED') {
          return { kind: 'VARIANT_NOT_EDITABLE' };
        }

        if (input.formulaRevisionId !== null) {
          const formula = await client.query(
            `
              SELECT id
              FROM wtm_formula_revisions
              WHERE id = $1 AND variant_id = $2
            `,
            [input.formulaRevisionId, input.productVariantId],
          );
          if (formula.rowCount !== 1) {
            return { kind: 'FORMULA_REVISION_NOT_FOUND' };
          }
        }

        const provenanceId = await insertProvenance(client, provenance);
        const inserted = await client.query<ProductClaimRow>(
          `
            INSERT INTO wtm_product_claims (
              variant_id,
              formula_revision_id,
              claim_kind,
              claim_text,
              provenance_id
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING ${claimColumns}
          `,
          [
            input.productVariantId,
            input.formulaRevisionId,
            input.kind,
            input.text,
            provenanceId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Product claim insert returned no row');
        return { kind: 'CREATED', claim: productClaim(row) };
      });
    },

    async transitionFamilyStatus(productFamilyId, target) {
      return withTransaction(pool, async (client) => {
        const selected = await client.query<StatusRow>(
          `
            SELECT family.status, provenance.rights_status
            FROM wtm_product_families AS family
            JOIN wtm_catalog_provenance AS provenance
              ON provenance.id = family.provenance_id
            WHERE family.id = $1
            FOR UPDATE OF family
          `,
          [productFamilyId],
        );
        const row = selected.rows[0];
        if (!row) return { kind: 'NOT_FOUND' };
        if (row.status === target) return { kind: 'UNCHANGED', status: target };
        if (!canTransitionCatalogStatus(row.status, target)) {
          return { kind: 'INVALID_TRANSITION' };
        }
        if (target === 'PUBLISHED' && row.rights_status !== 'ALLOWED') {
          return { kind: 'PROVENANCE_NOT_ALLOWED' };
        }
        if (target === 'ARCHIVED') {
          const activeVariants = await client.query(
            `
              SELECT 1
              FROM wtm_product_variants
              WHERE family_id = $1 AND status <> 'ARCHIVED'
              LIMIT 1
            `,
            [productFamilyId],
          );
          if (activeVariants.rowCount === 1) {
            return { kind: 'ACTIVE_VARIANTS_EXIST' };
          }
        }

        await client.query(
          `
            UPDATE wtm_product_families
            SET
              status = $2,
              updated_at = now(),
              published_at = CASE
                WHEN $2 = 'PUBLISHED' THEN now()
                ELSE published_at
              END,
              archived_at = CASE
                WHEN $2 = 'ARCHIVED' THEN now()
                ELSE NULL
              END
            WHERE id = $1
          `,
          [productFamilyId, target],
        );
        return { kind: 'UPDATED', status: target };
      });
    },

    async transitionVariantStatus(productVariantId, target) {
      return withTransaction(pool, async (client) => {
        const selected = await client.query<
          StatusRow & { family_status: CatalogStatus }
        >(
          `
            SELECT
              variant.status,
              provenance.rights_status,
              family.status AS family_status
            FROM wtm_product_variants AS variant
            JOIN wtm_product_families AS family ON family.id = variant.family_id
            JOIN wtm_catalog_provenance AS provenance
              ON provenance.id = variant.provenance_id
            WHERE variant.id = $1
            FOR UPDATE OF variant
          `,
          [productVariantId],
        );
        const row = selected.rows[0];
        if (!row) return { kind: 'NOT_FOUND' };
        if (row.status === target) return { kind: 'UNCHANGED', status: target };
        if (!canTransitionCatalogStatus(row.status, target)) {
          return { kind: 'INVALID_TRANSITION' };
        }
        if (target === 'PUBLISHED') {
          if (row.family_status !== 'PUBLISHED') {
            return { kind: 'PARENT_NOT_PUBLISHED' };
          }
          if (row.rights_status !== 'ALLOWED') {
            return { kind: 'PROVENANCE_NOT_ALLOWED' };
          }
        }

        await client.query(
          `
            UPDATE wtm_product_variants
            SET
              status = $2,
              updated_at = now(),
              published_at = CASE
                WHEN $2 = 'PUBLISHED' THEN now()
                ELSE published_at
              END,
              archived_at = CASE
                WHEN $2 = 'ARCHIVED' THEN now()
                ELSE NULL
              END
            WHERE id = $1
          `,
          [productVariantId, target],
        );
        return { kind: 'UPDATED', status: target };
      });
    },
  };
}
