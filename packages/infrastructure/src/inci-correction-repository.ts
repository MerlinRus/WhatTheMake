import type { Pool, PoolClient } from 'pg';

import {
  MAX_PRODUCT_OBSERVATION_INCI_REVISIONS,
  type AuthenticatedIdentity,
  type CreateProductObservationInciRevisionInput,
  type CreateProductObservationInciRevisionResult,
  type InciSourceSha256,
  type ProductObservationInciRepository,
  type ProductObservationInciRevision,
  type ProductObservationInciRevisionId,
  type ProductObservationInciRevisionSource,
  type ProductObservationInciWorkspace,
} from '@wtm/domain';

import { withTransaction } from './transaction.js';

type RevisionSourceKind = 'OCR' | 'USER_TRANSCRIPTION' | 'USER_CORRECTION';

interface RevisionRow {
  revision_id: string | null;
  revision_number: number | null;
  source_kind: RevisionSourceKind | null;
  source_text: string | null;
  source_sha256: string | null;
  based_on_revision_id: string | null;
  author_kind: ProductObservationInciRevision['authorKind'] | null;
  media_asset_id: string | null;
  provider_id: string | null;
  provider_version: string | null;
  created_at: Date | null;
}

interface WorkspaceRow extends RevisionRow {
  observation_id: string;
  revision_count: number | null;
  latest_revision_number: number | null;
}

function ownerParameters(
  owner: AuthenticatedIdentity,
): [string | null, string | null] {
  return owner.kind === 'GUEST'
    ? [owner.guestId, null]
    : [null, owner.accountId];
}

const ownedObservationPredicate = `
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

function revisionSource(
  row: RevisionRow,
): ProductObservationInciRevisionSource {
  switch (row.source_kind) {
    case 'OCR':
      if (
        row.media_asset_id === null ||
        row.provider_id === null ||
        row.provider_version === null
      ) {
        throw new Error('INCI OCR revision source is incomplete');
      }
      return {
        kind: 'OCR',
        mediaAssetId: row.media_asset_id,
        providerId: row.provider_id,
        providerVersion: row.provider_version,
      };
    case 'USER_TRANSCRIPTION':
      return { kind: 'USER_TRANSCRIPTION' };
    case 'USER_CORRECTION':
      if (row.based_on_revision_id === null) {
        throw new Error('INCI correction source is incomplete');
      }
      return {
        kind: 'USER_CORRECTION',
        basedOnRevisionId:
          row.based_on_revision_id as ProductObservationInciRevisionId,
      };
    default:
      throw new Error('INCI revision source is incomplete');
  }
}

function revision(row: RevisionRow): ProductObservationInciRevision {
  if (
    row.revision_id === null ||
    row.revision_number === null ||
    row.source_kind === null ||
    row.source_text === null ||
    row.source_sha256 === null ||
    row.author_kind === null ||
    row.created_at === null
  ) {
    throw new Error('INCI revision row is incomplete');
  }

  return {
    revisionId: row.revision_id as ProductObservationInciRevisionId,
    revisionNumber: row.revision_number,
    source: revisionSource(row),
    sourceText: row.source_text,
    sourceSha256: row.source_sha256.trim() as InciSourceSha256,
    authorKind: row.author_kind,
    createdAt: row.created_at,
  };
}

const revisionColumns = `
  revision.id AS revision_id,
  revision.revision_number,
  revision.source_kind,
  revision.source_text,
  revision.source_sha256,
  revision.based_on_revision_id,
  revision.author_kind,
  revision.media_asset_id,
  revision.provider_id,
  revision.provider_version,
  revision.created_at
`;

async function lockOwnedObservation(
  client: PoolClient,
  observationId: string,
  owner: AuthenticatedIdentity,
): Promise<boolean> {
  const [guestId, accountId] = ownerParameters(owner);
  const result = await client.query(
    `
      SELECT observation.id
      FROM wtm_product_observations AS observation
      LEFT JOIN wtm_guests AS observation_guest
        ON observation_guest.id = observation.guest_id
      WHERE observation.id = $1
        AND ${ownedObservationPredicate}
      FOR UPDATE OF observation
    `,
    [observationId, guestId, accountId],
  );
  return result.rowCount === 1;
}

function authorParameters(
  owner: AuthenticatedIdentity,
): [AuthenticatedIdentity['kind'], string | null, string | null] {
  return owner.kind === 'GUEST'
    ? ['GUEST', owner.guestId, null]
    : ['ACCOUNT', null, owner.accountId];
}

async function insertRevision(
  client: PoolClient,
  input: CreateProductObservationInciRevisionInput,
  revisionNumber: number,
): Promise<ProductObservationInciRevision> {
  const [authorKind, guestId, accountId] = authorParameters(input.owner);
  const basedOnRevisionId =
    input.kind === 'USER_CORRECTION' ? input.basedOnRevisionId : null;
  const inserted = await client.query<RevisionRow>(
    `
      INSERT INTO wtm_product_observation_inci_revisions (
        observation_id,
        revision_number,
        source_kind,
        source_text,
        source_sha256,
        based_on_revision_id,
        author_kind,
        guest_id,
        account_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id AS revision_id,
        revision_number,
        source_kind,
        source_text,
        source_sha256,
        based_on_revision_id,
        author_kind,
        media_asset_id,
        provider_id,
        provider_version,
        created_at
    `,
    [
      input.observationId,
      revisionNumber,
      input.kind,
      input.sourceText,
      input.sourceSha256,
      basedOnRevisionId,
      authorKind,
      guestId,
      accountId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('INCI revision insert returned no row');
  await client.query(
    'UPDATE wtm_product_observations SET updated_at = now() WHERE id = $1',
    [input.observationId],
  );
  return revision(row);
}

export function createPostgresProductObservationInciRepository(
  pool: Pool,
): ProductObservationInciRepository {
  return {
    async findWorkspace(observationId, owner) {
      const [guestId, accountId] = ownerParameters(owner);
      const result = await pool.query<WorkspaceRow>(
        `
          WITH owned_observation AS (
            SELECT observation.id
            FROM wtm_product_observations AS observation
            LEFT JOIN wtm_guests AS observation_guest
              ON observation_guest.id = observation.guest_id
            WHERE observation.id = $1
              AND ${ownedObservationPredicate}
          ),
          revisions AS (
            SELECT
              ${revisionColumns},
              count(*) OVER ()::integer AS revision_count,
              max(revision.revision_number) OVER ()::integer
                AS latest_revision_number
            FROM wtm_product_observation_inci_revisions AS revision
            JOIN owned_observation
              ON owned_observation.id = revision.observation_id
          )
          SELECT
            owned_observation.id AS observation_id,
            revisions.*
          FROM owned_observation
          LEFT JOIN revisions ON
            revisions.revision_number = 1
            OR revisions.revision_number = revisions.latest_revision_number
          ORDER BY revisions.revision_number
        `,
        [observationId, guestId, accountId],
      );
      if (result.rows.length === 0) return null;
      const revisionRows = result.rows.filter(
        (row) => row.revision_id !== null,
      );
      const mapped = revisionRows.map(revision);
      const original =
        mapped.find((entry) => entry.revisionNumber === 1) ?? null;
      const latest = mapped.at(-1) ?? null;
      const workspace: ProductObservationInciWorkspace = {
        original,
        latest,
        revisionCount: result.rows[0]?.revision_count ?? 0,
        maxRevisions: MAX_PRODUCT_OBSERVATION_INCI_REVISIONS,
      };
      return workspace;
    },

    async createRevision(
      input,
    ): Promise<CreateProductObservationInciRevisionResult> {
      return withTransaction(pool, async (client) => {
        if (
          !(await lockOwnedObservation(
            client,
            input.observationId,
            input.owner,
          ))
        ) {
          return { kind: 'OBSERVATION_NOT_FOUND' };
        }

        const existing = await client.query<RevisionRow>(
          `
            SELECT ${revisionColumns}
            FROM wtm_product_observation_inci_revisions AS revision
            WHERE revision.observation_id = $1
            ORDER BY revision.revision_number
          `,
          [input.observationId],
        );
        const revisions = existing.rows.map(revision);

        if (input.kind === 'USER_TRANSCRIPTION') {
          const original = revisions[0];
          if (original) {
            return original.sourceText === input.sourceText &&
              original.sourceSha256 === input.sourceSha256
              ? { kind: 'REUSED', revision: original }
              : { kind: 'SOURCE_ALREADY_EXISTS' };
          }
          return {
            kind: 'CREATED',
            revision: await insertRevision(client, input, 1),
          };
        }

        const base = revisions.find(
          (entry) => entry.revisionId === input.basedOnRevisionId,
        );
        if (!base) return { kind: 'REVISION_NOT_FOUND' };
        if (base.sourceText === input.sourceText) return { kind: 'SAME_TEXT' };

        const duplicate = revisions.find(
          (entry) =>
            entry.source.kind === 'USER_CORRECTION' &&
            entry.source.basedOnRevisionId === input.basedOnRevisionId &&
            entry.sourceSha256 === input.sourceSha256 &&
            entry.sourceText === input.sourceText,
        );
        if (duplicate) return { kind: 'REUSED', revision: duplicate };
        if (revisions.length >= MAX_PRODUCT_OBSERVATION_INCI_REVISIONS) {
          return { kind: 'LIMIT_REACHED' };
        }

        return {
          kind: 'CREATED',
          revision: await insertRevision(client, input, revisions.length + 1),
        };
      });
    },

    async findOwnedRevision(observationId, revisionId, owner) {
      const [guestId, accountId] = ownerParameters(owner);
      const result = await pool.query<RevisionRow>(
        `
          SELECT ${revisionColumns}
          FROM wtm_product_observation_inci_revisions AS revision
          JOIN wtm_product_observations AS observation
            ON observation.id = revision.observation_id
          LEFT JOIN wtm_guests AS observation_guest
            ON observation_guest.id = observation.guest_id
          WHERE observation.id = $1
            AND revision.id = $4
            AND ${ownedObservationPredicate}
        `,
        [observationId, guestId, accountId, revisionId],
      );
      const row = result.rows[0];
      return row ? revision(row) : null;
    },
  };
}
