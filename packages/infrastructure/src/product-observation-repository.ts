import type { Pool, PoolClient } from 'pg';

import type {
  AuthenticatedIdentity,
  Gtin14,
  GtinFormat,
  GtinValue,
  ImageMediaType,
  MediaAsset,
  MediaRole,
  ProductObservation,
  ProductObservationId,
  ProductObservationRepository,
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
  };
}
