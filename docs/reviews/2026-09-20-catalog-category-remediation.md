# Mascara category containment and remediation

## Evidence and immediate containment

The immutable `apps/server/seeds/mascara/seed.json` contains 213 imported rows.
Its acquisition filter accepted the word "mascara" even for primer, eyebrow
products and accessories. Publication assigned MASCARA to every accepted row;
neither lookup nor comparison rechecked contrary identity terms.

Seven rows have explicit names outside the current lash-mascara comparison scope:

| GTIN          | Name / category issue                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| 3600523503384 | L'Oréal Paris Lash Paradise Mascara Primer — primer                                      |
| 3350900001360 | mascara sourcil volumateur — eyebrow product                                             |
| 3600522734574 | Mascara perfecteur Sourcils étoffés chatain foncé — eyebrow product                      |
| 4250035271180 | Essence Lash Brow Gel Mascara — dual-use brow gel                                        |
| 8480000733498 | Máscara de pestañas y cejas transparente — dual-use brow gel                             |
| 8690644387005 | Show by Pastel Show Your Peace Transparent Eyebrow & Eyelash Mascara — dual-use brow gel |
| 8699067179549 | Promani Kirpik Dolgun Maskara Aplikatör — applicator                                     |

The guard excludes these named types from published lookup, comparison and new
imports. It does not prove the category of every remaining product. The public
lookup retains its existing error envelope: 404 NOT_FOUND with
`details.reason = UNSUPPORTED_CATEGORY`. Comparison uses its existing explicit
UNSUPPORTED_CATEGORY slot and never sends that known local rejection to discovery.
New imports quarantine these rows as INVALID_ROW, an existing persisted code.
OBF discovery shares the guard and prioritizes negative categories over mascara tags.

This is reversible application containment: deploy the reviewed release; retain
the previous release for rollback. It changes no catalog rows, formulas, barcodes,
provenance or original import manifests. Browser caches can retain old catalog
responses for up to the current cache policy window; comparison is re-evaluated
server-side. Do not mistake the old published batch replay report for a new
validation result: idempotent replay does not rewrite already-published rows.

## Safe production data remediation (not executed here)

1. Take the normal pre-release backup. Read-only join `wtm_product_barcodes`
   (`gtin14`, `variant_id`) to `wtm_product_variants` (`id`, `family_id`) and
   `wtm_product_families` (`id`). Resolve exactly the seven GTINs above and inspect
   their current names, status, provenance, claims and attached observations.
2. Save exact variant IDs plus original status, published_at, archived_at and
   updated_at in an access-controlled remediation record. Save each existing
   source attribution. Do not mutate the original seed or import event history.
3. If catalog withdrawal is desired after confirming the rows, transactionally
   archive only those resolved PUBLISHED variant IDs, retaining family records,
   barcodes, formulas, claims and linked user data. Use an expected-status/name
   predicate and abort on an unexpected count. Record the archive timestamp and
   affected IDs. Never roll back the entire 213-row import for this correction.
4. Verify public lookup/comparison and unrelated positive GTIN3600523503285.
   Preserve a category exclusion marker in a future curated revision if archive
   lookup must continue returning an explicit category reason rather than a miss.
5. Data rollback requires the saved exact row state and a transaction checking
   the remediation timestamp and unchanged identity. The existing repository
   intentionally forbids ARCHIVED -> PUBLISHED transitions; do not pretend the
   ordinary transition API can undo this. Prefer application containment alone
   until that audited restoration path is prepared.

Three examples requiring further source review, not automatic removal:
7891033926329 (EUDORA, "MASCARA ACELERA O CRESCIMENTO"), 7898430170423 (Trivitti,
"mascara") and 8479350755618 (Parisa cosmetics, "Bon voyage"). Their names alone
do not establish a contrary category. No inferred category fact was published.

## Verification pending

Server-only tests cover multilingual negative names, Brown-vs-brow false
positives, rejected local identity without external fallback, immutable seed
quarantine, and conflicting OBF category tags. Local formatting only was run.
This document does not claim deployment or successful executable verification.
