# Customer review moderation

This is a trusted operator CLI, not a public admin endpoint. No review is
automatically approved. Only approved current revisions contribute to the WTM
rating, and their source remains low-quality with no verified purchase or email.

View the oldest pending revisions (default 20, maximum 50):

```sh
docker exec whatthemake-web-1 node /app/apps/server/dist/cli/moderate-customer-review.js --list-pending
docker exec whatthemake-web-1 node /app/apps/server/dist/cli/moderate-customer-review.js --list-pending --limit 50
```

Queue output contains exact variant ID, review ID, expected revision number,
stars, submitted text, duplicate flag, update time and author pseudonym. Account
email and account ID are not included. Submitted text itself is untrusted and
may contain personal information: inspect it only in the trusted operator
terminal, do not publish or copy the queue into public logs. Blocked-account
reviews and approved/rejected/deleted reviews are excluded. Ordering is oldest
pending update first, with review ID as a deterministic tie-breaker. Editing a
review moves its new pending revision to its new update position.

For each item, inspect whether it describes the exact variant and actual use,
contains personal information or abusive content, or duplicates another review.
Do not approve batches blindly. A duplicate warning is not purchase verification.

Preview a decision using the IDs and revision from the queue:

```sh
docker exec whatthemake-web-1 node /app/apps/server/dist/cli/moderate-customer-review.js --review-id REVIEW_UUID --revision REVISION_NUMBER --approve --actor OPERATOR_LABEL --reason "Reviewed the exact submitted revision"
```

The command defaults to a read-only preview. To apply that individual decision,
repeat it with `--apply`. Use `--reject` instead of `--approve` to reject. Actor
and reason are recorded in the immutable moderation audit. The required revision
number prevents approving a newer user edit accidentally; `STALE_REVISION` means
list/read the new revision before deciding again. `DUPLICATE_TEXT` requires
reviewing the duplicate situation, not bypassing the guard. Deleted reviews or
blocked accounts cannot be approved. Re-run `--list-pending` after decisions to
see the next items; there is no auto-approval or mutation in list mode, and it
cannot be combined with `--apply`, `--approve` or `--reject`.

Exit `0` indicates a successful list/preview or applied decision. Exit `2` means
the target or decision was not accepted; exit `1` indicates invalid arguments or
an execution failure. List/preview output is a point-in-time view, not a lock or
guarantee that the revision still exists when the next command runs.
