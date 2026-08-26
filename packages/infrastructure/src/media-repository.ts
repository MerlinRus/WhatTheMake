import type { Pool } from 'pg';

import type {
  AuthenticatedIdentity,
  CommitMediaAssetUploadResult,
  ImageMediaType,
  MediaAsset,
  MediaCollection,
  MediaRecoveryJob,
  MediaRecoveryKind,
  MediaRepository,
  MediaRole,
  PrepareMediaAssetUploadResult,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

interface CollectionRow {
  collection_id: string;
  created_at: Date;
}

interface AssetRow {
  asset_id: string;
  role: MediaRole;
  media_type: ImageMediaType;
  byte_size: number;
  sha256: string;
  created_at: Date;
}

interface RecoveryJobRow {
  job_id: string;
  operation_kind: MediaRecoveryKind;
  resource_id: string;
  attempts: number;
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

const ownershipJoin = `
  LEFT JOIN wtm_guests AS owner_guest
    ON owner_guest.id = collection.guest_id
`;

const ownershipPredicate = `
  (
    (collection.owner_kind = 'GUEST' AND collection.guest_id = $2::uuid)
    OR
    (collection.owner_kind = 'ACCOUNT' AND collection.account_id = $3::uuid)
    OR
    (
      collection.owner_kind = 'GUEST'
      AND $3::uuid IS NOT NULL
      AND owner_guest.claimed_by_account_id = $3::uuid
    )
  )
`;

function ownerParameters(
  owner: AuthenticatedIdentity,
): [string | null, string | null] {
  return owner.kind === 'GUEST'
    ? [owner.guestId, null]
    : [null, owner.accountId];
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

const assetColumns = `
  asset.id AS asset_id,
  asset.role,
  asset.media_type,
  asset.byte_size,
  asset.sha256,
  asset.created_at
`;

const assetReturningColumns = `
  id AS asset_id,
  role,
  media_type,
  byte_size,
  sha256,
  created_at
`;

export function createPostgresMediaRepository(pool: Pool): MediaRepository {
  return {
    async createCollection(owner): Promise<MediaCollection> {
      const collection = await pool.query<CollectionRow>(
        `
          INSERT INTO wtm_media_collections (
            owner_kind,
            guest_id,
            account_id
          )
          VALUES ($1, $2, $3)
          RETURNING id AS collection_id, created_at
        `,
        [
          owner.kind,
          owner.kind === 'GUEST' ? owner.guestId : null,
          owner.kind === 'ACCOUNT' ? owner.accountId : null,
        ],
      );
      const row = collection.rows[0];
      if (!row) throw new Error('Media collection insert returned no row');
      return {
        collectionId: row.collection_id,
        assets: [],
        createdAt: row.created_at,
      };
    },

    async findOwnedCollection(collectionId, owner) {
      const [guestId, accountId] = ownerParameters(owner);
      const collection = await pool.query<CollectionRow>(
        `
          SELECT collection.id AS collection_id, collection.created_at
          FROM wtm_media_collections AS collection
          ${ownershipJoin}
          WHERE collection.id = $1
            AND collection.deleted_at IS NULL
            AND ${ownershipPredicate}
        `,
        [collectionId, guestId, accountId],
      );
      const row = collection.rows[0];
      if (!row) return null;

      const assets = await pool.query<AssetRow>(
        `
          SELECT ${assetColumns}
          FROM wtm_media_assets AS asset
          WHERE asset.collection_id = $1
            AND asset.deleted_at IS NULL
          ORDER BY asset.created_at, asset.id
        `,
        [collectionId],
      );
      return {
        collectionId: row.collection_id,
        assets: assets.rows.map(mediaAsset),
        createdAt: row.created_at,
      };
    },

    async prepareAssetUpload(input): Promise<PrepareMediaAssetUploadResult> {
      return withTransaction(pool, async (client) => {
        const [guestId, accountId] = ownerParameters(input.owner);
        const collection = await client.query(
          `
            SELECT collection.id
            FROM wtm_media_collections AS collection
            ${ownershipJoin}
            WHERE collection.id = $1
              AND collection.deleted_at IS NULL
              AND ${ownershipPredicate}
            FOR UPDATE OF collection
          `,
          [input.collectionId, guestId, accountId],
        );
        if (collection.rowCount !== 1) {
          return { kind: 'COLLECTION_NOT_FOUND' };
        }

        const count = await client.query<{ asset_count: number }>(
          `
            SELECT count(*)::integer AS asset_count
            FROM wtm_media_assets
            WHERE collection_id = $1 AND deleted_at IS NULL
          `,
          [input.collectionId],
        );
        if ((count.rows[0]?.asset_count ?? 0) >= 5) {
          return { kind: 'CAPACITY_REACHED' };
        }

        const reservations = await client.query<{ reservation_count: number }>(
          `
            SELECT count(*)::integer AS reservation_count
            FROM wtm_media_recovery_jobs
            WHERE collection_id = $1
              AND operation_kind = 'ABANDONED_UPLOAD'
              AND status IN ('PENDING', 'PROCESSING')
          `,
          [input.collectionId],
        );
        if (
          (count.rows[0]?.asset_count ?? 0) +
            (reservations.rows[0]?.reservation_count ?? 0) >=
          5
        ) {
          return { kind: 'CAPACITY_REACHED' };
        }

        await client.query(
          `
            INSERT INTO wtm_media_recovery_jobs (
              operation_kind,
              resource_id,
              collection_id,
              available_at
            )
            VALUES (
              'ABANDONED_UPLOAD',
              $1,
              $2,
              now() + ($3::integer * interval '1 millisecond')
            )
          `,
          [input.assetId, input.collectionId, input.recoveryDelayMs],
        );
        return { kind: 'PREPARED' };
      });
    },

    async commitAssetUpload(input): Promise<CommitMediaAssetUploadResult> {
      try {
        return await withTransaction(pool, async (client) => {
          const recovery = await client.query(
            `
            SELECT id
            FROM wtm_media_recovery_jobs
            WHERE operation_kind = 'ABANDONED_UPLOAD'
              AND resource_id = $1
              AND collection_id = $2
              AND status = 'PENDING'
            FOR UPDATE
          `,
            [input.assetId, input.collectionId],
          );
          if (recovery.rowCount !== 1) {
            return { kind: 'RECOVERY_NOT_PENDING' };
          }

          const asset = await client.query<AssetRow>(
            `
            INSERT INTO wtm_media_assets (
              id,
              collection_id,
              role,
              media_type,
              byte_size,
              sha256
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING ${assetReturningColumns}
          `,
            [
              input.assetId,
              input.collectionId,
              input.role,
              input.mediaType,
              input.byteSize,
              input.sha256,
            ],
          );
          const row = asset.rows[0];
          if (!row) throw new Error('Media asset insert returned no row');

          await client.query(
            `
            UPDATE wtm_media_recovery_jobs
            SET status = 'COMPLETED',
                locked_at = NULL,
                completed_at = now(),
                updated_at = now(),
                last_error_code = NULL
            WHERE operation_kind = 'ABANDONED_UPLOAD'
              AND resource_id = $1
          `,
            [input.assetId],
          );
          return { kind: 'CREATED', asset: mediaAsset(row) };
        });
      } catch (error) {
        if (
          isConstraintViolation(
            error,
            'wtm_media_assets_collection_role_active_unique',
          )
        ) {
          return { kind: 'ROLE_OCCUPIED' };
        }
        throw error;
      }
    },

    async completePreparedAssetUpload(assetId): Promise<void> {
      await pool.query(
        `
          UPDATE wtm_media_recovery_jobs
          SET status = 'COMPLETED',
              locked_at = NULL,
              completed_at = now(),
              updated_at = now(),
              last_error_code = NULL
          WHERE operation_kind = 'ABANDONED_UPLOAD'
            AND resource_id = $1
            AND status = 'PENDING'
        `,
        [assetId],
      );
    },

    async findOwnedAsset(assetId, owner): Promise<MediaAsset | null> {
      const [guestId, accountId] = ownerParameters(owner);
      const asset = await pool.query<AssetRow>(
        `
          SELECT ${assetColumns}
          FROM wtm_media_assets AS asset
          JOIN wtm_media_collections AS collection
            ON collection.id = asset.collection_id
          ${ownershipJoin}
          WHERE asset.id = $1
            AND asset.deleted_at IS NULL
            AND collection.deleted_at IS NULL
            AND ${ownershipPredicate}
        `,
        [assetId, guestId, accountId],
      );
      const row = asset.rows[0];
      return row ? mediaAsset(row) : null;
    },

    async scheduleOwnedAssetDeletion(assetId, owner): Promise<boolean> {
      return withTransaction(pool, async (client) => {
        const [guestId, accountId] = ownerParameters(owner);
        const asset = await client.query<AssetRow>(
          `
            SELECT ${assetColumns}
            FROM wtm_media_assets AS asset
            JOIN wtm_media_collections AS collection
              ON collection.id = asset.collection_id
            ${ownershipJoin}
            WHERE asset.id = $1
              AND asset.deleted_at IS NULL
              AND collection.deleted_at IS NULL
              AND ${ownershipPredicate}
            FOR UPDATE OF asset
          `,
          [assetId, guestId, accountId],
        );
        const row = asset.rows[0];
        if (!row) return false;

        await client.query(
          'UPDATE wtm_media_assets SET deleted_at = now() WHERE id = $1',
          [assetId],
        );
        await client.query(
          `
            INSERT INTO wtm_media_recovery_jobs (
              operation_kind,
              resource_id
            )
            VALUES ('DELETE_ASSET', $1)
            ON CONFLICT (operation_kind, resource_id) DO NOTHING
          `,
          [assetId],
        );
        return true;
      });
    },

    async claimRecoveryJob(leaseMs): Promise<MediaRecoveryJob | null> {
      const claimed = await pool.query<RecoveryJobRow>(
        `
          WITH candidate AS (
            SELECT id
            FROM wtm_media_recovery_jobs
            WHERE available_at <= now()
              AND (
                status = 'PENDING'
                OR (
                  status = 'PROCESSING'
                  AND locked_at <= now() - ($1::integer * interval '1 millisecond')
                )
              )
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE wtm_media_recovery_jobs AS job
          SET status = 'PROCESSING',
              attempts = job.attempts + 1,
              locked_at = now(),
              updated_at = now(),
              last_error_code = NULL
          FROM candidate
          WHERE job.id = candidate.id
          RETURNING
            job.id AS job_id,
            job.operation_kind,
            job.resource_id,
            job.attempts
        `,
        [leaseMs],
      );
      const row = claimed.rows[0];
      return row
        ? {
            jobId: row.job_id,
            kind: row.operation_kind,
            assetId: row.resource_id,
            attempts: row.attempts,
          }
        : null;
    },

    async completeRecoveryJob(jobId, attempt): Promise<void> {
      await pool.query(
        `
          UPDATE wtm_media_recovery_jobs
          SET status = 'COMPLETED',
              locked_at = NULL,
              completed_at = now(),
              updated_at = now(),
              last_error_code = NULL
          WHERE id = $1
            AND status = 'PROCESSING'
            AND attempts = $2
        `,
        [jobId, attempt],
      );
    },

    async retryRecoveryJob(jobId, attempt, delayMs, errorCode): Promise<void> {
      await pool.query(
        `
          UPDATE wtm_media_recovery_jobs
          SET status = 'PENDING',
              available_at = now() + ($3::integer * interval '1 millisecond'),
              locked_at = NULL,
              updated_at = now(),
              last_error_code = $4
          WHERE id = $1
            AND status = 'PROCESSING'
            AND attempts = $2
        `,
        [jobId, attempt, delayMs, errorCode],
      );
    },
  };
}
