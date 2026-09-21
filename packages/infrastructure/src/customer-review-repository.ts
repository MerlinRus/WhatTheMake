import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  hasUnsupportedMascaraCategory,
  normalizeCustomerReviewText,
  type CustomerReview,
  type CustomerReviewRepository,
  type CustomerReviewStatus,
  type CustomerReviewSummary,
  type UpsertCustomerReviewResult,
} from '@wtm/domain';
import { withTransaction } from './transaction.js';

interface ReviewRow {
  account_id: string;
  id: string;
  variant_id: string;
  current_revision_number: number;
  status: CustomerReviewStatus;
  duplicate_text: boolean;
  created_at: Date;
  updated_at: Date;
  stars: number;
  body: string;
  normalized_sha256: string;
  revision_created_at: Date;
}
const select = `SELECT review.*, revision.stars, revision.body, revision.normalized_sha256,
  revision.created_at AS revision_created_at FROM wtm_customer_reviews AS review
  JOIN wtm_customer_review_revisions AS revision ON revision.review_id = review.id
    AND revision.revision_number = review.current_revision_number`;
function map(row: ReviewRow): CustomerReview {
  return {
    reviewId: row.id,
    productVariantId: row.variant_id,
    revisionNumber: row.current_revision_number,
    stars: row.stars,
    text: row.body,
    status: row.status,
    duplicateText: row.duplicate_text,
    verifiedPurchase: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function moderationEntry(row: ReviewRow) {
  return {
    review: map(row),
    authorPseudonym: `wtm-${createHash('sha256').update(row.account_id).digest('hex').slice(0, 16)}`,
  };
}
function validText(value: string, min: number, max: number): boolean {
  const length = Array.from(value).length;
  return (
    length >= min &&
    length <= max &&
    !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}
async function hashLock(client: PoolClient, hash: string): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 6016))',
    [hash],
  );
}
async function audit(
  client: PoolClient,
  row: { id: string; current_revision_number: number },
  action: string,
  actor: string,
  reason: string,
  before: CustomerReviewStatus | null,
  after: CustomerReviewStatus,
): Promise<void> {
  await client.query(
    `INSERT INTO wtm_customer_review_audit
    (review_id, revision_number, action, actor_label, reason, previous_status, next_status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.id, row.current_revision_number, action, actor, reason, before, after],
  );
}
async function activeAccount(
  client: PoolClient,
  accountId: string,
): Promise<boolean> {
  const result = await client.query(
    "SELECT id FROM wtm_accounts WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
    [accountId],
  );
  return result.rowCount === 1;
}

export function createPostgresCustomerReviewRepository(
  pool: Pool,
): CustomerReviewRepository {
  return {
    async listPendingForModeration(limit = 20) {
      const bounded = Number.isFinite(limit)
        ? Math.max(1, Math.min(50, Math.floor(limit)))
        : 20;
      const result = await pool.query<ReviewRow>(
        `${select} JOIN wtm_accounts AS account ON account.id = review.account_id
         WHERE review.status = 'PENDING' AND account.status = 'ACTIVE'
         ORDER BY review.updated_at ASC, review.id ASC LIMIT $1`,
        [bounded],
      );
      return result.rows.map(moderationEntry);
    },
    async findForModeration(reviewId) {
      const result = await pool.query<ReviewRow>(
        `${select} WHERE review.id = $1`,
        [reviewId],
      );
      const row = result.rows[0];
      return row ? moderationEntry(row) : null;
    },
    async upsert(input): Promise<UpsertCustomerReviewResult> {
      const text = normalizeCustomerReviewText(input.text);
      if (
        !Number.isInteger(input.stars) ||
        input.stars < 1 ||
        input.stars > 5 ||
        !validText(text, 20, 4000)
      )
        return { kind: 'INVALID_INPUT' };
      return withTransaction<UpsertCustomerReviewResult>(
        pool,
        async (client) => {
          if (!(await activeAccount(client, input.accountId)))
            return { kind: 'ACCOUNT_NOT_FOUND' };
          const variant = await client.query<{
            family_name: string;
            variant_name: string;
          }>(
            `SELECT family.name AS family_name, variant.name AS variant_name
          FROM wtm_product_variants AS variant JOIN wtm_product_families AS family ON family.id = variant.family_id
          WHERE variant.id = $1 AND variant.status = 'PUBLISHED' AND family.status = 'PUBLISHED'`,
            [input.productVariantId],
          );
          if (
            !variant.rows[0] ||
            hasUnsupportedMascaraCategory(
              variant.rows[0].family_name,
              variant.rows[0].variant_name,
            )
          )
            return { kind: 'VARIANT_NOT_FOUND' };
          const previous = (
            await client.query<ReviewRow>(
              `${select} WHERE review.account_id = $1 AND review.variant_id = $2 FOR UPDATE OF review`,
              [input.accountId, input.productVariantId],
            )
          ).rows[0];
          if (
            previous &&
            previous.status !== 'DELETED' &&
            previous.stars === input.stars &&
            previous.body === text
          )
            return { kind: 'UNCHANGED', review: map(previous) };
          const hash = createHash('sha256')
            .update(text.toLowerCase())
            .digest('hex');
          await hashLock(client, hash);
          const duplicates = await client.query(
            `${select} JOIN wtm_accounts AS account ON account.id = review.account_id
          WHERE revision.normalized_sha256 = $1 AND review.status <> 'DELETED' AND account.status = 'ACTIVE'
            AND ($2::uuid IS NULL OR review.id <> $2::uuid) LIMIT 1`,
            [hash, previous?.id ?? null],
          );
          const duplicate = duplicates.rowCount !== 0;
          const number = (previous?.current_revision_number ?? 0) + 1;
          const head = previous
            ? (
                await client.query<{ id: string }>(
                  `UPDATE wtm_customer_reviews SET current_revision_number = $2, status = 'PENDING', duplicate_text = $3, updated_at = clock_timestamp() WHERE id = $1 RETURNING id`,
                  [previous.id, number, duplicate],
                )
              ).rows[0]
            : (
                await client.query<{ id: string }>(
                  `INSERT INTO wtm_customer_reviews (account_id, variant_id, current_revision_number, duplicate_text) VALUES ($1,$2,1,$3) RETURNING id`,
                  [input.accountId, input.productVariantId, duplicate],
                )
              ).rows[0];
          if (!head) throw new Error('Review write returned no identity');
          await client.query(
            `INSERT INTO wtm_customer_review_revisions (review_id, revision_number, stars, body, normalized_sha256) VALUES ($1,$2,$3,$4,$5)`,
            [head.id, number, input.stars, text, hash],
          );
          await audit(
            client,
            { id: head.id, current_revision_number: number },
            previous ? 'EDITED' : 'SUBMITTED',
            'ACCOUNT_OWNER',
            duplicate
              ? 'Duplicate normalized text; requires moderation'
              : 'Awaiting moderation',
            previous?.status ?? null,
            'PENDING',
          );
          const row = (
            await client.query<ReviewRow>(`${select} WHERE review.id = $1`, [
              head.id,
            ])
          ).rows[0];
          if (!row) throw new Error('Saved review was not found');
          return { kind: previous ? 'UPDATED' : 'CREATED', review: map(row) };
        },
      );
    },
    async findOwned(accountId, productVariantId) {
      const result = await pool.query<ReviewRow>(
        `${select} JOIN wtm_accounts AS account ON account.id = review.account_id
        WHERE review.account_id = $1 AND review.variant_id = $2 AND account.status = 'ACTIVE'`,
        [accountId, productVariantId],
      );
      return result.rows[0] ? map(result.rows[0]) : null;
    },
    async deleteOwned(accountId, productVariantId) {
      return withTransaction(pool, async (client) => {
        if (!(await activeAccount(client, accountId))) return 'NOT_FOUND';
        const row = (
          await client.query<ReviewRow>(
            `${select} WHERE review.account_id = $1 AND review.variant_id = $2 FOR UPDATE OF review`,
            [accountId, productVariantId],
          )
        ).rows[0];
        if (!row) return 'NOT_FOUND';
        if (row.status === 'DELETED') return 'DELETED';
        await client.query(
          "UPDATE wtm_customer_reviews SET status = 'DELETED', updated_at = clock_timestamp() WHERE id = $1",
          [row.id],
        );
        await audit(
          client,
          row,
          'DELETED',
          'ACCOUNT_OWNER',
          'Deleted by author',
          row.status,
          'DELETED',
        );
        return 'DELETED';
      });
    },
    async moderate(input) {
      const actor = input.actorLabel.trim();
      const reason = input.reason.trim();
      if (
        !validText(actor, 1, 200) ||
        !validText(reason, 1, 1000) ||
        !Number.isInteger(input.revisionNumber) ||
        input.revisionNumber < 1 ||
        !['APPROVED', 'REJECTED'].includes(input.decision)
      )
        return 'INVALID_INPUT';
      return withTransaction(pool, async (client) => {
        const row = (
          await client.query<ReviewRow>(
            `${select} JOIN wtm_accounts AS account ON account.id = review.account_id
          WHERE review.id = $1 AND account.status = 'ACTIVE' FOR UPDATE OF review`,
            [input.reviewId],
          )
        ).rows[0];
        if (!row || row.status === 'DELETED') return 'NOT_FOUND';
        if (row.current_revision_number !== input.revisionNumber)
          return 'STALE_REVISION';
        await hashLock(client, row.normalized_sha256);
        if (input.decision === 'APPROVED') {
          const duplicate = await client.query(
            `${select} JOIN wtm_accounts AS account ON account.id = review.account_id
            CROSS JOIN wtm_customer_review_revisions AS current_revision
            WHERE current_revision.review_id = $1 AND current_revision.revision_number = $3
              AND review.id <> $1 AND account.status = 'ACTIVE' AND review.status IN ('PENDING','APPROVED')
              AND revision.normalized_sha256 = $2 AND
              (review.status = 'APPROVED' OR (revision.created_at, review.id) < (current_revision.created_at, $1::uuid)) LIMIT 1`,
            [row.id, row.normalized_sha256, row.current_revision_number],
          );
          if (duplicate.rowCount !== 0) return 'DUPLICATE_TEXT';
        }
        await client.query(
          'UPDATE wtm_customer_reviews SET status = $2, updated_at = clock_timestamp() WHERE id = $1',
          [row.id, input.decision],
        );
        await audit(
          client,
          row,
          'MODERATED',
          actor,
          reason,
          row.status,
          input.decision,
        );
        return 'MODERATED';
      });
    },
    async summary(
      productVariantId,
      limit = 20,
    ): Promise<CustomerReviewSummary> {
      const bounded = Number.isFinite(limit)
        ? Math.max(1, Math.min(20, Math.floor(limit)))
        : 20;
      const result = await pool.query<{
        id: string;
        stars: number;
        body: string;
        created_at: Date;
        review_count: number;
        rating_value: number;
        as_of: Date;
      }>(
        `
        WITH approved AS (
          SELECT review.id, review.variant_id, revision.stars, revision.body, revision.created_at, review.updated_at,
            row_number() OVER (PARTITION BY revision.normalized_sha256 ORDER BY revision.created_at, review.id) AS duplicate_rank
          FROM wtm_customer_reviews AS review
          JOIN wtm_customer_review_revisions AS revision ON revision.review_id = review.id AND revision.revision_number = review.current_revision_number
          JOIN wtm_accounts AS account ON account.id = review.account_id
          JOIN wtm_product_variants AS variant ON variant.id = review.variant_id
          JOIN wtm_product_families AS family ON family.id = variant.family_id
          WHERE review.status = 'APPROVED' AND account.status = 'ACTIVE' AND variant.status = 'PUBLISHED' AND family.status = 'PUBLISHED'
        ) SELECT id, stars, body, created_at, count(*) OVER ()::integer AS review_count,
          avg(stars) OVER ()::double precision AS rating_value, max(updated_at) OVER () AS as_of
        FROM approved WHERE variant_id = $1 AND duplicate_rank = 1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [productVariantId, bounded],
      );
      const first = result.rows[0];
      return {
        source: 'WTM',
        sourceQuality: 'LOW',
        verifiedPurchase: false,
        ratingValue: first ? Math.round(first.rating_value * 100) / 100 : null,
        reviewCount: first?.review_count ?? 0,
        asOf: first?.as_of ?? null,
        reviews: result.rows.map((row) => ({
          reviewId: row.id,
          stars: row.stars,
          text: row.body,
          verifiedPurchase: false,
          createdAt: row.created_at,
        })),
      };
    },
  };
}
