# Byte-storage contract coverage

Specification: internal blob contract v0.1, `requirements.json` (B01–B08), all MUST.
`blob.test.ts` runs the same eight requirements against the filesystem and R2
adapters. `verify.test.ts` additionally checks reusable producer buffers cannot
change the bytes between hashing and writing.

| Section | MUST clauses | Required executions |
|---|---:|---:|
| Exact bytes, rejection and limits | 3 (B01–B03) | 6 |
| Immutability, concurrency and emptiness | 3 (B04–B06) | 6 |
| Cancellation and namespace isolation | 2 (B07–B08) | 4 |

`pnpm test` generates actual verdicts in `runtime/blob-conformance.md` from Vitest
JSON. Missing, skipped, duplicate or failing cases fail coverage accounting. CI
runs the same generator. This file lists expected coverage, not inferred passes.

The R2 adapter is bundled and executed in workerd through Miniflare; it uses real
local R2 bindings and native FixedLengthStream. The tiny synthetic test request
envelope is buffered by the fixture router, then supplied to the real adapter in
three-byte chunks. This avoids TCP reset ambiguity when intentionally rejecting
an upload early. The stalled-upload case creates its stream and deadline inside
the Worker itself. Production adapter code never buffers an entire object.

Not established: remote R2 behavior, crash/power-loss durability, remote permissions,
deployment lifecycle rules, garbage collection of abandoned verified objects,
multipart uploads or public HTTP authorization. Asset-service tests separately
cover database completion failures and workspace isolation on native storage.
