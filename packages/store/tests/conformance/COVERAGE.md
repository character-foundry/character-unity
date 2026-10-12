# Store contract coverage

Specification: internal store contract v0.1 in `requirements.json` (S01–S18).
Every listed clause is a MUST, tested against both native SQLite and local D1.
The shared suite is `store.test.ts`. These are specification-derived tests, not
outputs captured from the unsafe predecessor implementation.

Run `pnpm test` at the repository root. It writes a Vitest JSON report and then
generates `runtime/store-conformance.md`. A missing, duplicate, skipped or failing
driver case fails coverage accounting. CI runs this same command via `pnpm check`.

| Section | MUST clauses | Required executions | Evidence |
|---|---:|---:|---|
| Migration safety | 4 (S01, S02, S14, S16) | 8 | History validation, foreign DB rejection, failing DDL batch |
| Revisions and provenance | 8 (S03–S07, S09, S13, S15) | 16 | Snapshot, failure injection, CAS races, immutable forks/revisions |
| Isolation, assets and bounds | 4 (S08, S10–S12) | 8 | Workspace scoping, completion measurements, input limits, pagination |

The generated report records actual passing counts; this file defines expected
coverage. SQLite additionally has a separate on-disk reopen/two-connection test.
The API has readiness tests and the built Node HTTP smoke checks the real schema.

Failure injection inserts a NOT NULL constraint violation after every statement
of create/save/fork batches, including the final seal, so it tests runtime rollback
rather than relying on SQL parsing failure before any write executes.

Outside this store suite: production D1/network behavior, remote federation,
authorization, actual blob writes/byte hashing/cleanup, Foundry canonical content
verification, browser persistence, live Archive adoption. Those are
separate foundation/vertical-slice gates, not exceptions to this store contract.

The companion `hub.test.ts` runs H01–H05 from `hub-requirements.json` on both
drivers: exact atomic selections, immutable snapshots/versioned policies,
permission-checked atomic forks, current ancestor restrictions and visible-root
pagination with no hidden-row cursors. It uses only
synthetic documents/digests and injected actor IDs. `runtime/hub-conformance.md`
records its ten executions; service and HTTP tests separately cover SDK identity
and the host authentication boundary.

`accounts.test.ts` runs A01–A06 from `accounts-requirements.json` on both drivers:
credential separation, expiry, revocation, bounded session counts, transactional
write guards and key-rotation races. `runtime/accounts-conformance.md` records the
twelve executions. D1 change counts include rows deleted by the account-revocation
trigger; repository results account for this without weakening revocation checks.

`asset-maintenance.test.ts` runs M01–M06 from
`asset-maintenance-requirements.json` on both drivers. Coverage accounting requires
all 12 cases in `runtime/asset-maintenance-conformance.md`. These test age bounds,
all three reference families, retirement/attachment races, rollback, lost
responses, persistent immutable tombstones and populated v8 migration. Separate
`asset-sweeps.test.ts` tests actual filesystem and local R2 removal, lost deletion
acknowledgments and late uploads. `apps/api/src/assets-cli.test.ts` checks the
operator commands across separate processes with persisted SQLite and D1/R2.

`chat.test.ts` runs C01–C03 from `chat-requirements.json` on both drivers:
workspace-scoped chat-app targets with credentials kept out of listings,
placement status derived against the card head (current/behind) and from complete
scans (edited/missing), failed scans that keep known copies, and resolving exported
copies back to library revisions by lineage revision hash, then content hash.
