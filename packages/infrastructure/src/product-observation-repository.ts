import type { Pool, PoolClient } from 'pg';

import type {
  AuthenticatedIdentity,
  CatalogPromotionIdentity,
  CatalogPromotionState,
  Gtin14,
  GtinFormat,
  GtinValue,
  ImageMediaType,
  MediaAsset,
  MediaRole,
  ProductObservation,
  ProductObservationConfirmationId,
  ProductObservationId,
  ProductObservationRepository,
  ProductVariantId,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

interface ObservationRow {
  observation_id: string;
  gtin_value: string;
  gtin_format: GtinFormat;
  gtin14: string;
  media_collection_id: string;
  observation_created_at: Date;
  updated_at: Date;
  collection_created_at: Date;
}

interface AssetRow {
  asset_id: string;
  role: MediaRole;
  media_type: ImageMediaType;
  byte_size: number;
  sha256: string;
  created_at: Date;
}

interface OwnedObservationPromotionRow {
  gtin_value: string;
  gtin_format: GtinFormat;
  gtin14: string;
}

interface PromotionCaseRow {
  status: CatalogPromotionState['state'];
  product_variant_id: string | null;
}

interface PromotionConfirmationRow {
  fingerprint: string;
  brand_name: string;
  family_name: string;
  variant_name: string;
  shade_name: string | null;
  net_quantity_value: string | null;
  net_quantity_unit: CatalogPromotionIdentity['netQuantityUnit'];
  waterproof: boolean | null;
  gtin_value: string;
  gtin_format: GtinFormat;
  gtin14: string;
}

interface PromotionStateRow extends PromotionCaseRow {
  matching_account_count: number;
}

function ownerParameters(
  owner: AuthenticatedIdentity,
): [string | null, string | null] {
  return owner.kind === 'GUEST'
    ? [owner.guestId, null]
    : [null, owner.accountId];
}

const ownershipJoin = `
  LEFT JOIN wtm_guests AS observation_guest
    ON observation_guest.id = observation.guest_id
`;

const ownershipPredicate = `
  (
    (observation.owner_kind = 'GUEST' AND observation.guest_id = $2::uuid)
    OR
    (observation.owner_kind = 'ACCOUNT' AND observation.account_id = $3::uuid)
    OR
    (
      observation.owner_kind = 'GUEST'
      AND $3::uuid IS NOT NULL
      AND observation_guest.claimed_by_account_id = $3::uuid
    )
  )
`;

async function findOwnedRow(
  queryable: Pool | PoolClient,
  filter: 'ID' | 'GTIN',
  value: string,
  owner: AuthenticatedIdentity,
): Promise<ObservationRow | null> {
  const [guestId, accountId] = ownerParameters(owner);
  const filterSql =
    filter === 'ID' ? 'observation.id = $1::uuid' : 'observation.gtin14 = $1';
  const result = await queryable.query<ObservationRow>(
    `
      SELECT
        observation.id AS observation_id,
        observation.gtin_value,
        observation.gtin_format,
        observation.gtin14,
        observation.media_collection_id,
        observation.created_at AS observation_created_at,
        observation.updated_at,
        collection.created_at AS collection_created_at
      FROM wtm_product_observations AS observation
      JOIN wtm_media_collections AS collection
        ON collection.id = observation.media_collection_id
      ${ownershipJoin}
      WHERE ${filterSql}
        AND collection.deleted_at IS NULL
        AND ${ownershipPredicate}
      ORDER BY
        CASE WHEN observation.owner_kind = $4 THEN 0 ELSE 1 END,
        observation.updated_at DESC,
        observation.id
      LIMIT 1
    `,
    [value, guestId, accountId, owner.kind],
  );
  return result.rows[0] ?? null;
}

function mediaAsset(row: AssetRow): MediaAsset {
  return {
    assetId: row.asset_id,
    role: row.role,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    sha256: row.sha256.trim(),
    createdAt: row.created_at,
  };
}

async function productObservation(
  queryable: Pool | PoolClient,
  row: ObservationRow,
): Promise<ProductObservation> {
  const assets = await queryable.query<AssetRow>(
    `
      SELECT
        id AS asset_id,
        role,
        media_type,
        byte_size,
        sha256,
        created_at
      FROM wtm_media_assets
      WHERE collection_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at, id
    `,
    [row.media_collection_id],
  );
  return {
    observationId: row.observation_id as ProductObservationId,
    barcode: {
      value: row.gtin_value as GtinValue,
      format: row.gtin_format,
      gtin14: row.gtin14 as Gtin14,
    },
    mediaCollection: {
      collectionId: row.media_collection_id,
      assets: assets.rows.map(mediaAsset),
      createdAt: row.collection_created_at,
    },
    createdAt: row.observation_created_at,
    updatedAt: row.updated_at,
  };
}

async function selectPromotionCase(
  client: PoolClient,
  promotionCaseId: string,
): Promise<PromotionCaseRow | null> {
  const selected = await client.query<PromotionCaseRow>(
    `
      SELECT status, product_variant_id
      FROM wtm_catalog_promotion_cases
      WHERE id = $1
      FOR UPDATE
    `,
    [promotionCaseId],
  );
  return selected.rows[0] ?? null;
}

async function promotionState(
  client: PoolClient,
  promotionCaseId: string,
  fingerprint: string,
): Promise<CatalogPromotionState> {
  const selected = await client.query<PromotionStateRow>(
    `
      SELECT
        promotion.status,
        promotion.product_variant_id,
        count(confirmation.id) FILTER (
          WHERE confirmation.fingerprint = $2
        )::integer AS matching_account_count
      FROM wtm_catalog_promotion_cases AS promotion
      LEFT JOIN wtm_product_observation_confirmations AS confirmation
        ON confirmation.promotion_case_id = promotion.id
      WHERE promotion.id = $1
      GROUP BY promotion.id
    `,
    [promotionCaseId, fingerprint],
  );
  const row = selected.rows[0];
  if (!row) throw new Error('Catalog promotion case could not be read');
  if (row.status === 'PUBLISHED') {
    if (!row.product_variant_id) {
      throw new Error('Published catalog promotion has no variant');
    }
    return {
      state: 'PUBLISHED',
      matchingAccountCount: row.matching_account_count,
      productVariantId: row.product_variant_id as ProductVariantId,
    };
  }
  return {
    state: row.status,
    matchingAccountCount: row.matching_account_count,
    productVariantId: null,
  };
}

async function publishPromotion(
  client: PoolClient,
  input: {
    promotionCaseId: string;
    fingerprint: string;
    identity: CatalogPromotionIdentity;
    barcode: OwnedObservationPromotionRow;
    resolution:
      { kind: 'AUTO_QUORUM' } | { kind: 'ADMIN'; moderatorAccountId: string };
  },
): Promise<'PUBLISHED' | 'CATALOG_CONFLICT'> {
  const existingBarcode = await client.query(
    'SELECT 1 FROM wtm_product_barcodes WHERE gtin14 = $1',
    [input.barcode.gtin14],
  );
  if (existingBarcode.rowCount === 1) return 'CATALOG_CONFLICT';

  const provenance = await client.query<{ id: string }>(
    `
      INSERT INTO wtm_catalog_provenance (
        source_kind,
        source_label,
        source_record_id,
        observed_at,
        rights_status
      )
      VALUES ($1, $2, $3, now(), 'ALLOWED')
      RETURNING id
    `,
    [
      input.resolution.kind === 'ADMIN' ? 'ADMIN' : 'USER_OBSERVATION',
      input.resolution.kind === 'ADMIN'
        ? 'Admin-reviewed community identity'
        : 'Community-confirmed identity',
      input.promotionCaseId,
    ],
  );
  const provenanceId = provenance.rows[0]?.id;
  if (!provenanceId)
    throw new Error('Promotion provenance insert returned no row');

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
    [input.identity.brandName, input.identity.familyName, provenanceId],
  );
  const productFamilyId = family.rows[0]?.id;
  if (!productFamilyId)
    throw new Error('Promotion family insert returned no row');

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
      input.identity.variantName,
      input.identity.shadeName,
      input.identity.netQuantityValue,
      input.identity.netQuantityUnit,
      input.identity.waterproof,
      provenanceId,
    ],
  );
  const productVariantId = variant.rows[0]?.id;
  if (!productVariantId)
    throw new Error('Promotion variant insert returned no row');

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
      input.barcode.gtin14,
      input.barcode.gtin_value,
      input.barcode.gtin_format,
      productVariantId,
      provenanceId,
    ],
  );
  await client.query(
    `
      UPDATE wtm_catalog_promotion_cases
      SET
        status = 'PUBLISHED',
        conflict_reason = NULL,
        selected_fingerprint = $2,
        product_variant_id = $3,
        resolution_kind = $4,
        moderated_by_account_id = $5,
        updated_at = now(),
        published_at = now()
      WHERE id = $1
    `,
    [
      input.promotionCaseId,
      input.fingerprint,
      productVariantId,
      input.resolution.kind,
      input.resolution.kind === 'ADMIN'
        ? input.resolution.moderatorAccountId
        : null,
    ],
  );
  return 'PUBLISHED';
}

function confirmationIdentity(
  row: PromotionConfirmationRow,
): CatalogPromotionIdentity {
  return {
    brandName: row.brand_name,
    familyName: row.family_name,
    variantName: row.variant_name,
    shadeName: row.shade_name,
    netQuantityValue: row.net_quantity_value,
    netQuantityUnit: row.net_quantity_unit,
    waterproof: row.waterproof,
  };
}

export function createPostgresProductObservationRepository(
  pool: Pool,
): ProductObservationRepository {
  return {
    async createOrReuse(owner, barcode) {
      return withTransaction(pool, async (client) => {
        const ownerId =
          owner.kind === 'GUEST' ? owner.guestId : owner.accountId;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`product-observation:${owner.kind}:${ownerId}:${barcode.gtin14}`],
        );

        const existing = await findOwnedRow(
          client,
          'GTIN',
          barcode.gtin14,
          owner,
        );
        if (existing) {
          return {
            kind: 'REUSED',
            observation: await productObservation(client, existing),
          };
        }

        const collection = await client.query<{ collection_id: string }>(
          `
            INSERT INTO wtm_media_collections (
              owner_kind,
              guest_id,
              account_id
            )
            VALUES ($1, $2, $3)
            RETURNING id AS collection_id
          `,
          [
            owner.kind,
            owner.kind === 'GUEST' ? owner.guestId : null,
            owner.kind === 'ACCOUNT' ? owner.accountId : null,
          ],
        );
        const collectionId = collection.rows[0]?.collection_id;
        if (!collectionId) {
          throw new Error(
            'Product observation collection insert returned no row',
          );
        }

        const inserted = await client.query<{ observation_id: string }>(
          `
            INSERT INTO wtm_product_observations (
              owner_kind,
              guest_id,
              account_id,
              gtin_value,
              gtin_format,
              gtin14,
              media_collection_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id AS observation_id
          `,
          [
            owner.kind,
            owner.kind === 'GUEST' ? owner.guestId : null,
            owner.kind === 'ACCOUNT' ? owner.accountId : null,
            barcode.value,
            barcode.format,
            barcode.gtin14,
            collectionId,
          ],
        );
        const observationId = inserted.rows[0]?.observation_id;
        if (!observationId) {
          throw new Error('Product observation insert returned no row');
        }

        const row = await findOwnedRow(client, 'ID', observationId, owner);
        if (!row)
          throw new Error('Created product observation could not be read');
        return {
          kind: 'CREATED',
          observation: await productObservation(client, row),
        };
      });
    },

    async findOwned(observationId, owner) {
      const row = await findOwnedRow(pool, 'ID', observationId, owner);
      return row ? productObservation(pool, row) : null;
    },

    async submitCatalogConfirmation(input) {
      return withTransaction(pool, async (client) => {
        const observation = await client.query<OwnedObservationPromotionRow>(
          `
            SELECT
              observation.gtin_value,
              observation.gtin_format,
              observation.gtin14
            FROM wtm_product_observations AS observation
            LEFT JOIN wtm_guests AS observation_guest
              ON observation_guest.id = observation.guest_id
            WHERE observation.id = $1
              AND (
                (
                  observation.owner_kind = 'ACCOUNT'
                  AND observation.account_id = $2
                )
                OR (
                  observation.owner_kind = 'GUEST'
                  AND observation_guest.claimed_by_account_id = $2
                )
              )
            FOR UPDATE OF observation
          `,
          [input.observationId, input.accountId],
        );
        const observationRow = observation.rows[0];
        if (!observationRow) return { kind: 'NOT_FOUND' };

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [observationRow.gtin14],
        );
        const insertedCase = await client.query<{ id: string }>(
          `
            INSERT INTO wtm_catalog_promotion_cases (gtin14)
            VALUES ($1)
            ON CONFLICT (gtin14) DO NOTHING
            RETURNING id
          `,
          [observationRow.gtin14],
        );
        const promotionCaseId =
          insertedCase.rows[0]?.id ??
          (
            await client.query<{ id: string }>(
              'SELECT id FROM wtm_catalog_promotion_cases WHERE gtin14 = $1',
              [observationRow.gtin14],
            )
          ).rows[0]?.id;
        if (!promotionCaseId) {
          throw new Error('Catalog promotion case insert returned no row');
        }
        const promotionCase = await selectPromotionCase(
          client,
          promotionCaseId,
        );
        if (!promotionCase) {
          throw new Error('Catalog promotion case could not be locked');
        }

        const existing = await client.query<{
          id: string;
          fingerprint: string;
        }>(
          `
            SELECT id, fingerprint
            FROM wtm_product_observation_confirmations
            WHERE promotion_case_id = $1 AND account_id = $2
          `,
          [promotionCaseId, input.accountId],
        );
        const existingRow = existing.rows[0];
        if (existingRow) {
          if (existingRow.fingerprint !== input.fingerprint) {
            return { kind: 'ALREADY_CONFIRMED' };
          }
          return {
            kind: 'REUSED',
            confirmationId: existingRow.id as ProductObservationConfirmationId,
            promotion: await promotionState(
              client,
              promotionCaseId,
              input.fingerprint,
            ),
          };
        }
        if (promotionCase.status === 'PUBLISHED') {
          return { kind: 'PROMOTION_CLOSED' };
        }

        const confirmation = await client.query<{ id: string }>(
          `
            INSERT INTO wtm_product_observation_confirmations (
              promotion_case_id,
              observation_id,
              account_id,
              fingerprint,
              brand_name,
              family_name,
              variant_name,
              shade_name,
              net_quantity_value,
              net_quantity_unit,
              waterproof
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
          `,
          [
            promotionCaseId,
            input.observationId,
            input.accountId,
            input.fingerprint,
            input.identity.brandName,
            input.identity.familyName,
            input.identity.variantName,
            input.identity.shadeName,
            input.identity.netQuantityValue,
            input.identity.netQuantityUnit,
            input.identity.waterproof,
          ],
        );
        const confirmationId = confirmation.rows[0]?.id;
        if (!confirmationId) {
          throw new Error('Catalog confirmation insert returned no row');
        }

        const counts = await client.query<{
          matching_account_count: number;
          fingerprint_count: number;
        }>(
          `
            SELECT
              count(*) FILTER (WHERE fingerprint = $2)::integer
                AS matching_account_count,
              count(DISTINCT fingerprint)::integer AS fingerprint_count
            FROM wtm_product_observation_confirmations
            WHERE promotion_case_id = $1
          `,
          [promotionCaseId, input.fingerprint],
        );
        const countRow = counts.rows[0];
        if (!countRow) throw new Error('Catalog confirmation counts missing');

        if (
          promotionCase.status === 'NEEDS_MODERATION' ||
          countRow.fingerprint_count > 1
        ) {
          await client.query(
            `
              UPDATE wtm_catalog_promotion_cases
              SET
                status = 'NEEDS_MODERATION',
                conflict_reason = COALESCE(
                  conflict_reason,
                  'IDENTITY_MISMATCH'
                ),
                updated_at = now()
              WHERE id = $1
            `,
            [promotionCaseId],
          );
        } else if (countRow.matching_account_count >= 2) {
          const published = await publishPromotion(client, {
            promotionCaseId,
            fingerprint: input.fingerprint,
            identity: input.identity,
            barcode: observationRow,
            resolution: { kind: 'AUTO_QUORUM' },
          });
          if (published === 'CATALOG_CONFLICT') {
            await client.query(
              `
                UPDATE wtm_catalog_promotion_cases
                SET
                  status = 'NEEDS_MODERATION',
                  conflict_reason = 'CATALOG_GTIN_CONFLICT',
                  updated_at = now()
                WHERE id = $1
              `,
              [promotionCaseId],
            );
          }
        }

        return {
          kind: 'CREATED',
          confirmationId: confirmationId as ProductObservationConfirmationId,
          promotion: await promotionState(
            client,
            promotionCaseId,
            input.fingerprint,
          ),
        };
      });
    },

    async moderateCatalogPromotion(input) {
      return withTransaction(pool, async (client) => {
        const caseGtin = await client.query<{ gtin14: string }>(
          'SELECT gtin14 FROM wtm_catalog_promotion_cases WHERE id = $1',
          [input.promotionCaseId],
        );
        const gtin14 = caseGtin.rows[0]?.gtin14;
        if (!gtin14) return { kind: 'CASE_NOT_FOUND' };
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [gtin14],
        );
        const promotionCase = await selectPromotionCase(
          client,
          input.promotionCaseId,
        );
        if (!promotionCase) return { kind: 'CASE_NOT_FOUND' };
        if (promotionCase.status === 'PUBLISHED') {
          return { kind: 'PROMOTION_CLOSED' };
        }

        const selected = await client.query<PromotionConfirmationRow>(
          `
            SELECT
              confirmation.fingerprint,
              confirmation.brand_name,
              confirmation.family_name,
              confirmation.variant_name,
              confirmation.shade_name,
              confirmation.net_quantity_value,
              confirmation.net_quantity_unit,
              confirmation.waterproof,
              observation.gtin_value,
              observation.gtin_format,
              observation.gtin14
            FROM wtm_product_observation_confirmations AS confirmation
            JOIN wtm_product_observations AS observation
              ON observation.id = confirmation.observation_id
            WHERE confirmation.id = $1
              AND confirmation.promotion_case_id = $2
          `,
          [input.confirmationId, input.promotionCaseId],
        );
        const selectedRow = selected.rows[0];
        if (!selectedRow) return { kind: 'CONFIRMATION_NOT_FOUND' };

        const published = await publishPromotion(client, {
          promotionCaseId: input.promotionCaseId,
          fingerprint: selectedRow.fingerprint,
          identity: confirmationIdentity(selectedRow),
          barcode: selectedRow,
          resolution: {
            kind: 'ADMIN',
            moderatorAccountId: input.moderatorAccountId,
          },
        });
        if (published === 'CATALOG_CONFLICT') {
          await client.query(
            `
              UPDATE wtm_catalog_promotion_cases
              SET
                status = 'NEEDS_MODERATION',
                conflict_reason = 'CATALOG_GTIN_CONFLICT',
                updated_at = now()
              WHERE id = $1
            `,
            [input.promotionCaseId],
          );
          return { kind: 'CATALOG_CONFLICT' };
        }
        return {
          kind: 'PUBLISHED',
          promotion: await promotionState(
            client,
            input.promotionCaseId,
            selectedRow.fingerprint,
          ),
        };
      });
    },
  };
}
