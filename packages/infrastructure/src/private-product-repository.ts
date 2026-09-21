import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  MAX_PRIVATE_PRODUCT_SNAPSHOTS,
  type AuthenticatedIdentity,
  type CreatePrivateProductSnapshotInput,
  type CreatePrivateProductSnapshotResult,
  type PrivateProductRepository,
  type PrivateProductSnapshot,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

interface SnapshotRow {
  id: PrivateProductSnapshot['snapshotId'];
  observation_id: PrivateProductSnapshot['observationId'];
  snapshot_number: number;
  gtin_value: PrivateProductSnapshot['barcode']['value'];
  gtin_format: PrivateProductSnapshot['barcode']['format'];
  gtin14: PrivateProductSnapshot['barcode']['gtin14'];
  brand_name: string;
  family_name: string;
  variant_name: string;
  shade_name: string | null;
  net_quantity_value: string | null;
  net_quantity_unit: PrivateProductSnapshot['identity']['netQuantityUnit'];
  waterproof: boolean | null;
  formula_complete: boolean;
  claim_kinds: PrivateProductSnapshot['claimKinds'];
  price_kopecks: number | null;
  created_at: Date;
  revision: Omit<PrivateProductSnapshot['revision'], 'createdAt'> & {
    createdAt: string;
  };
}

function ownerParameters(
  owner: AuthenticatedIdentity,
): [string | null, string | null] {
  return owner.kind === 'GUEST'
    ? [owner.guestId, null]
    : [null, owner.accountId];
}

const ownedPredicate = `collection.deleted_at IS NULL AND (
  (observation.owner_kind = 'GUEST' AND observation.guest_id = $2::uuid
    AND observation_guest.claimed_by_account_id IS NULL AND observation_guest.deleted_at IS NULL)
  OR (observation.owner_kind = 'ACCOUNT' AND observation.account_id = $3::uuid)
  OR (observation.owner_kind = 'GUEST' AND $3::uuid IS NOT NULL
    AND observation_guest.claimed_by_account_id = $3::uuid AND observation_guest.deleted_at IS NULL)
)`;

const observationJoins = `
  JOIN wtm_product_observations AS observation ON observation.id = snapshot.observation_id
  JOIN wtm_media_collections AS collection ON collection.id = observation.media_collection_id
  LEFT JOIN wtm_guests AS observation_guest ON observation_guest.id = observation.guest_id
`;

const snapshotSelect = `
  SELECT snapshot.*, observation.gtin_value, observation.gtin_format, observation.gtin14,
    json_build_object(
      'revisionId', revision.id, 'revisionNumber', revision.revision_number,
      'sourceText', revision.source_text, 'sourceSha256', revision.source_sha256,
      'authorKind', revision.author_kind, 'createdAt', revision.created_at,
      'source', CASE revision.source_kind
        WHEN 'OCR' THEN json_build_object('kind', 'OCR', 'mediaAssetId', revision.media_asset_id,
          'providerId', revision.provider_id, 'providerVersion', revision.provider_version)
        WHEN 'USER_CORRECTION' THEN json_build_object('kind', 'USER_CORRECTION',
          'basedOnRevisionId', revision.based_on_revision_id)
        ELSE json_build_object('kind', 'USER_TRANSCRIPTION')
      END
    ) AS revision
  FROM wtm_private_product_snapshots AS snapshot
  ${observationJoins}
  JOIN wtm_product_observation_inci_revisions AS revision
    ON revision.observation_id = snapshot.observation_id AND revision.id = snapshot.revision_id
`;

function mapSnapshot(row: SnapshotRow): PrivateProductSnapshot {
  return {
    snapshotId: row.id,
    observationId: row.observation_id,
    snapshotNumber: row.snapshot_number,
    category: 'MASCARA',
    barcode: {
      value: row.gtin_value,
      format: row.gtin_format,
      gtin14: row.gtin14,
    },
    identity: {
      brandName: row.brand_name,
      familyName: row.family_name,
      variantName: row.variant_name,
      shadeName: row.shade_name,
      netQuantityValue: row.net_quantity_value,
      netQuantityUnit: row.net_quantity_unit,
      waterproof: row.waterproof,
    },
    identitySource: 'USER_CONFIRMED_PACKAGING',
    revision: { ...row.revision, createdAt: new Date(row.revision.createdAt) },
    formulaComplete: row.formula_complete,
    claimKinds: row.claim_kinds,
    claimsSource: 'USER_CONFIRMED_PACKAGING',
    priceKopecks: row.price_kopecks,
    priceSource: row.price_kopecks === null ? null : 'USER_ENTERED',
    createdAt: row.created_at,
  };
}

async function findOwned(
  executor: Pool | PoolClient,
  snapshotId: PrivateProductSnapshot['snapshotId'],
  owner: AuthenticatedIdentity,
): Promise<PrivateProductSnapshot | null> {
  const result = await executor.query<SnapshotRow>(
    `${snapshotSelect} WHERE snapshot.id = $1 AND ${ownedPredicate}`,
    [snapshotId, ...ownerParameters(owner)],
  );
  const row = result.rows[0];
  return row ? mapSnapshot(row) : null;
}

function fingerprint(
  input: CreatePrivateProductSnapshotInput,
  claimKinds: string[],
): string {
  const identity = input.identity;
  return createHash('sha256')
    .update(
      JSON.stringify([
        'private-product-v1',
        input.revisionId,
        input.category,
        input.identityConfirmed,
        identity.brandName,
        identity.familyName,
        identity.variantName,
        identity.shadeName,
        identity.netQuantityValue,
        identity.netQuantityUnit,
        identity.waterproof,
        input.formulaComplete ?? false,
        claimKinds,
        input.priceKopecks,
      ]),
    )
    .digest('hex');
}

export function createPostgresPrivateProductRepository(
  pool: Pool,
): PrivateProductRepository {
  return {
    async createSnapshot(input): Promise<CreatePrivateProductSnapshotResult> {
      return withTransaction(pool, async (client) => {
        const owned = await client.query(
          `SELECT observation.id FROM wtm_product_observations AS observation
           JOIN wtm_media_collections AS collection ON collection.id = observation.media_collection_id
           LEFT JOIN wtm_guests AS observation_guest ON observation_guest.id = observation.guest_id
           WHERE observation.id = $1 AND ${ownedPredicate}
           FOR UPDATE OF observation, collection`,
          [input.observationId, ...ownerParameters(input.owner)],
        );
        if (owned.rowCount !== 1) return { kind: 'OBSERVATION_NOT_FOUND' };
        const revision = await client.query(
          'SELECT id FROM wtm_product_observation_inci_revisions WHERE observation_id = $1 AND id = $2',
          [input.observationId, input.revisionId],
        );
        if (revision.rowCount !== 1) return { kind: 'REVISION_NOT_FOUND' };

        const claimKinds = [...new Set(input.claimKinds)].sort();
        const contentFingerprint = fingerprint(input, claimKinds);
        const existing = await client.query<{
          id: PrivateProductSnapshot['snapshotId'];
          snapshot_number: number;
          fingerprint: string;
        }>(
          'SELECT id, snapshot_number, fingerprint FROM wtm_private_product_snapshots WHERE observation_id = $1 ORDER BY snapshot_number DESC',
          [input.observationId],
        );
        const duplicate = existing.rows.find(
          (row) => row.fingerprint === contentFingerprint,
        );
        if (duplicate) {
          const snapshot = await findOwned(client, duplicate.id, input.owner);
          if (!snapshot)
            throw new Error('Locked private snapshot was not found');
          return { kind: 'REUSED', snapshot };
        }
        if (existing.rows.length >= MAX_PRIVATE_PRODUCT_SNAPSHOTS)
          return { kind: 'LIMIT_REACHED' };

        const identity = input.identity;
        const inserted = await client.query<{
          id: PrivateProductSnapshot['snapshotId'];
        }>(
          `INSERT INTO wtm_private_product_snapshots (
            observation_id, revision_id, snapshot_number, fingerprint, category, identity_confirmed,
            brand_name, family_name, variant_name, shade_name, net_quantity_value, net_quantity_unit,
            waterproof, formula_complete, claim_kinds, price_kopecks
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [
            input.observationId,
            input.revisionId,
            existing.rows.length + 1,
            contentFingerprint,
            input.category,
            input.identityConfirmed,
            identity.brandName,
            identity.familyName,
            identity.variantName,
            identity.shadeName,
            identity.netQuantityValue,
            identity.netQuantityUnit,
            identity.waterproof,
            input.formulaComplete ?? false,
            claimKinds,
            input.priceKopecks,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Private snapshot insert returned no row');
        const snapshot = await findOwned(client, row.id, input.owner);
        if (!snapshot)
          throw new Error('Created private snapshot was not found');
        return { kind: 'CREATED', snapshot };
      });
    },
    findOwned(snapshotId, owner) {
      return findOwned(pool, snapshotId, owner);
    },
    async listOwned(owner, limit = 20) {
      const boundedLimit = Number.isFinite(limit)
        ? Math.max(1, Math.min(30, Math.floor(limit)))
        : 20;
      const result = await pool.query<SnapshotRow>(
        `${snapshotSelect} WHERE ${ownedPredicate} ORDER BY snapshot.created_at DESC, snapshot.id DESC LIMIT $1`,
        [boundedLimit, ...ownerParameters(owner)],
      );
      return result.rows.map(mapSnapshot);
    },
  };
}
