# Media disk reserve

Uploads have an 8 MiB file bound and five active/pending images per collection,
but neither bounds total storage across unlimited collections/guests. Retained
guest data does not expire. Rate limits slow accumulation; they are not a quota.

The local media adapter accepts `minimumFreeBytes` (default zero for existing
non-production consumers). Production must explicitly configure 4 GiB. Before
creating an asset, it uses Node `statfs(..., { bigint: true })` and checks available
unprivileged blocks (`bavail * bsize`) against reserve plus incoming bytes.
Capacity checks and writes are serialized within that adapter instance. Failed
checks fail closed. Reading, deletion and recovery do not require spare capacity.

A known capacity refusal occurs before opening an asset file. The service releases
that unused upload reservation without deleting an object and returns 503 with
`MEDIA_STORAGE_CAPACITY`, `retryable: true`, `Retry-After: 60`, and no-store.
If journal completion fails, the durable recovery job remains for retry. Other
write failures retain the journal. Partial writes are closed and best-effort
unlinked only after this call successfully opened a new file with `wx`; EEXIST
never removes the old object. No host path/free-space value is returned to users.

This is a **soft reserve**, not a project filesystem quota or a guarantee of
host isolation. Other processes/instances, directory metadata, database growth,
backups and restore copies can consume the same filesystem concurrently. Multiple
web processes would need a shared admission mechanism or filesystem quota. The
backup job needs its own size/headroom guard, independently of upload admission.
Do not promise that 4 GiB will always remain free or delete active user media to
enforce this reserve. Operational low-disk alerts remain necessary.

Tests exercise fake capacity/partial-write failures without filling a disk,
concurrent admission, EEXIST preservation, recovery-slot handling and the HTTP 503
contract. They must run on the server; no local test execution was performed.
