# Archive read coverage

Specification: internal Archive read v1, `requirements.json` (A01–A10), all MUST.
Cases live in `apps/archive/src/read-contract.test.ts`, exercising the actual
typed client against the actual Hono service and immutable in-memory source.
`pnpm test` regenerates `runtime/archive-conformance.md` from Vitest verdicts;
missing, duplicate, skipped and failing requirements fail coverage accounting.

Exact-byte tests use independent Node SHA-256 digests and synthetic bytes with
whitespace, Unicode and opaque fields. Pagination tests verify filter binding,
ordering and corpus changes. Selection tests reject partial or expanded subsets.
Ownership tests mutate input and returned arrays to check snapshot isolation.
Malformed-server tests exercise the client separately from the shared parser.
Cancellation, deadlines and redirect rejection use a real loopback HTTP server.
Root `pnpm smoke` also starts the built Archive executable in off and fixture modes
and verifies metadata → selected manifest → exact original bytes over HTTP.

Not established: a real Archive database/search adapter, concurrent live corpus
updates, LanceDB parity, copied-data adoption, signed manifests, authorization,
large-file streaming or external-app card format compatibility.
