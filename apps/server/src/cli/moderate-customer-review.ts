import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDatabase } from '@wtm/infrastructure';
import { loadServerConfig } from '../config.js';

export interface ReviewModerationDecisionCommand {
  kind: 'MODERATE';
  apply: boolean;
  reviewId: string;
  revisionNumber: number;
  decision: 'APPROVED' | 'REJECTED';
  actorLabel: string;
  reason: string;
}
export type ReviewModerationCommand =
  ReviewModerationDecisionCommand | { kind: 'LIST_PENDING'; limit: number };
export function parseReviewModerationCommand(
  args: readonly string[],
): ReviewModerationCommand {
  if (args.includes('--list-pending')) {
    let listed = false;
    let limit: number | undefined;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--list-pending' && !listed) listed = true;
      else if (args[index] === '--limit' && limit === undefined) {
        const value = args[++index] ?? '';
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 50)
          throw new Error(
            'Pending queue limit must be an integer from 1 to 50',
          );
        limit = Number(value);
      } else {
        throw new Error(
          'Use --list-pending with optional --limit only; no moderation decision is applied',
        );
      }
    }
    return { kind: 'LIST_PENDING', limit: limit ?? 20 };
  }
  const values = new Map<string, string>();
  let mode: string | undefined;
  let decision: ReviewModerationDecisionCommand['decision'] | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply' || arg === '--dry-run') {
      if (mode) throw new Error('Choose one execution mode');
      mode = arg;
    } else if (arg === '--approve' || arg === '--reject') {
      if (decision) throw new Error('Choose one decision');
      decision = arg === '--approve' ? 'APPROVED' : 'REJECTED';
    } else if (
      arg &&
      ['--review-id', '--revision', '--actor', '--reason'].includes(arg) &&
      !values.has(arg) &&
      args[i + 1] &&
      !args[i + 1]!.startsWith('--')
    )
      values.set(arg, args[++i]!.trim());
    else
      throw new Error(
        'Use --review-id, --revision, --actor, --reason, --approve or --reject, and optional --apply or --dry-run',
      );
  }
  const reviewId = values.get('--review-id') ?? '';
  const revision = values.get('--revision') ?? '';
  const actorLabel = values.get('--actor') ?? '';
  const reason = values.get('--reason') ?? '';
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      reviewId,
    ) ||
    !/^[1-9]\d*$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    !decision ||
    actorLabel.length < 1 ||
    actorLabel.length > 200 ||
    reason.length < 1 ||
    reason.length > 1000 ||
    /\p{Cc}/u.test(actorLabel + reason)
  )
    throw new Error('Invalid moderation identity, revision, actor or reason');
  return {
    kind: 'MODERATE',
    apply: mode === '--apply',
    reviewId,
    revisionNumber: Number(revision),
    decision,
    actorLabel,
    reason,
  };
}
async function main(): Promise<void> {
  const command = parseReviewModerationCommand(process.argv.slice(2));
  const config = loadServerConfig(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 1,
    applicationName: 'wtm-review-moderation',
  });
  try {
    if (command.kind === 'LIST_PENDING') {
      const pending = await database.customerReviews.listPendingForModeration(
        command.limit,
      );
      console.info(
        JSON.stringify({
          kind: 'PENDING_QUEUE',
          limit: command.limit,
          order: 'OLDEST_PENDING_FIRST',
          reviews: pending.map(({ review, authorPseudonym }) => ({
            reviewId: review.reviewId,
            revisionNumber: review.revisionNumber,
            productVariantId: review.productVariantId,
            stars: review.stars,
            text: review.text,
            duplicateText: review.duplicateText,
            updatedAt: review.updatedAt.toISOString(),
            authorPseudonym,
          })),
          note: 'Read-only queue. Inspect each revision; no approval or rejection is performed.',
        }),
      );
      return;
    }
    const target = await database.customerReviews.findForModeration(
      command.reviewId,
    );
    if (!target) {
      console.info(JSON.stringify({ kind: 'NOT_FOUND' }));
      process.exitCode = 2;
      return;
    }
    if (!command.apply) {
      console.info(
        JSON.stringify({
          kind: 'DRY_RUN',
          target,
          requestedRevision: command.revisionNumber,
          decision: command.decision,
          revisionMatches:
            target.review.revisionNumber === command.revisionNumber,
          note: 'Read-only preview; final ownership, status and duplicate checks run atomically with --apply.',
        }),
      );
      return;
    }
    const result = await database.customerReviews.moderate(command);
    console.info(
      JSON.stringify({
        kind: result,
        reviewId: command.reviewId,
        revisionNumber: command.revisionNumber,
      }),
    );
    if (result !== 'MODERATED') process.exitCode = 2;
  } finally {
    await database.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch {
    console.error(
      JSON.stringify({
        kind: 'ERROR',
        message:
          'Review moderation command failed; check arguments and server configuration.',
      }),
    );
    process.exitCode = 1;
  }
}
