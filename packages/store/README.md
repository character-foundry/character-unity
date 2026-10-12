# Shared workspace store

One SQLite schema for Architect/hub workspaces, cards, immutable revisions,
parent/fork relationships and staged/completed asset metadata. Archive data
never lives here. Node and D1 share repository SQL and migrations.

```ts
import { openNodeStore } from '@character-unity/store/node';

const database = await openNodeStore('unity.db');
try {
  const workspace = await database.store.createWorkspace({ ownerId: 'local', name: 'Desk' });
  // Supply a Foundry-validated document and identity before creating revisions.
  console.log(workspace.id);
} finally {
  database.close();
}
```

Node initializes a new database, validates migration history, then enables WAL.
It rejects unfamiliar application databases. The parent directory must already
exist. Native code lives only in the `/node` export.

For D1, use `createD1Store` from `/d1` with a binding or request-scoped D1 session.
Use `migrate(createD1Driver(binding))` in an administrative operation, never the
Worker fetch handler. The scaffold's Worker has no D1 binding yet; the adapter
is tested against local D1. No remote database has been created or migrated.

## Mutation contract

`createCard`, `saveRevision` and `forkCard` each execute one atomic statement batch.
An insert trigger compares the parent against the current card head, advances
that head, and rejects stale edits. Revision IDs differ from content hashes.
Asset references join the same batch; a final seal prevents later attachments.
SQL guards reject revision/manifest rewrites and provenance changes. Failures
roll back all of these effects on both drivers.

`stageAsset` allocates metadata and a storage key. Only a trusted blob service may
call `completeAsset` with a measured digest and byte count after writing bytes.
The database checks these measurements; it does not upload or independently
read/hash the object. The [asset service](../assets/README.md) performs that work.
Staged or foreign workspace assets cannot attach to revisions. Temporary uploads
are cleaned; abandoned final-object garbage collection remains future work.

The repository is a trusted application layer, **not an authentication service**.
Hosts authorize workspaces, authors and fork sources. Ordinary reads and saves
are workspace-scoped; explicit forks may link an authorized source in another
workspace. HTTP mutations use the authorized card service rather than exposing these methods directly.

Documents are opaque JSON snapshots (max 256 KiB, depth 64), with at most 64 asset
references. The store validates JSON and identity shape but does not parse cards,
compute canonical hashes or serialize lineage; those remain Foundry primitives.
It never adds lineage to an untouched original.

See [coverage](tests/conformance/COVERAGE.md), [provenance](tests/conformance/PROVENANCE.md)
and [discrepancies](tests/conformance/DISCREPANCIES.md). `pnpm test` generates actual
driver results in `runtime/store-conformance.md`.

Schema v3 adds the hub repository at `/hub`. `openNodeStore` also returns `hub`;
portable hosts use `createHubStore(driver)`. It pins sanitized publication
snapshots, atomically commits selections, compares policy versions and records
immutable parent publication relations. The optional `publication` guard on
`forkCard` joins current ancestor permission checks to the same atomic fork batch.
Browser storage rejects this SQL-only guard. See [publication behavior](../../docs/hub-publication.md)
and the separate `runtime/hub-conformance.md` report.

Schema v4 adds `/accounts` for operator-created account keys and revocable,
expiring sessions. Only credential digests persist. Node returns `accounts` and
`forSession(proof)`; portable composition uses `createSessionDriver(driver, proof)`.
This driver guards each domain write in its SQL batch and validates session access
after reads. Session guard rows exist only inside that batch. See
[account setup and semantics](../../docs/hub-accounts.md) and the fourteen required
SQLite/D1 checks in `runtime/accounts-conformance.md`.

Schema v8 adds `/sync-outbox`. `openNodeStore` and its session-scoped composition
return `outbox`; portable hosts use `createSyncOutboxStore(driver)`. Jobs pin ready
frame assets, saved revisions, actor/destination and operation IDs. Append-only
attempts and acknowledgments distinguish prepared, uncertain and acknowledged
returns. Six requirements run on both drivers, including restart, concurrency,
session revocation, failed commits and a populated v7 upgrade. See
[durable return jobs](../../docs/sync-outbox.md) and `runtime/sync-outbox-conformance.md`.

Schema v9 adds `/asset-maintenance`, an operator-only repository for paginated
unused-asset previews and atomic permanent retirements. SQL guards prevent all
new references and completion after retirement; every historical attachment,
original source and outbox frame blocks retirement. Creation timestamps are
immutable, with conservative migration-time backfill for older assets. Normal
asset reads hide retired records. See [asset maintenance](../../docs/asset-maintenance.md)
for the two-phase storage workflow and delayed-upload limitations.
