# Asset retirement and cleanup

`pnpm assets` is an explicit operator tool for Unity's SQL-owned final objects.
It supports native SQLite/filesystem storage and local Worker D1/R2. There is no
HTTP deletion route, scheduled collector, remote Worker cleanup or browser
IndexedDB collector. Foundry and Archive storage are outside its scope.

Run normal host migration before maintenance. The commands require schema 9 and
validate migration history; they do not install a Unity schema or migrate it.
Always select the matching Unity database and blob directory explicitly. Never
point them at an Archive path or another application's storage.

## Preview, retire, sweep

Choose a canonical UTC cutoff at least 24 hours in the past. The example below
uses the default development paths, relative to the repository root:

```sh
pnpm assets preview --database apps/api/runtime/unity.db --before 2026-10-01T00:00:00.000Z
pnpm assets retire --database apps/api/runtime/unity.db --before 2026-10-01T00:00:00.000Z --id ASSET_ID
pnpm assets sweep --database apps/api/runtime/unity.db --blob-dir apps/api/runtime/blobs
```

Preview lists unused staged or ready records, with IDs, storage keys, byte lengths
and creation timestamps. It does not change asset state. Review those IDs before
passing them to `retire`; repeat `--id` for up to 100 exact selections. Retirement
is permanent. A batch rechecks age and every reference in SQL and commits all
selected retirements or none. A stale selection fails if a save attached an asset
since preview. Retrying an already committed retirement is idempotent.

Preview and sweep default to 50 records per page, with `--limit 1..100` and
`--after ID`. Continue using each JSON result's `nextAfter` until it is null;
an exactly full last page may require one empty-page request. Asset IDs, rather
than timestamps, determine stable ordering.

Sweep deletes only keys recorded in the permanent retirement ledger. Its JSON
lists each asset as `removed` (including an already absent key) or `failed`.
Failures do not stop the page, but cause exit status 1. Retry failures after
resolving the storage error. Filesystem removal accepts existing real directories
and ordinary files; symlinks and hard links are refused. Both backends restrict
removal to valid `assets/` keys. Original imports stored in that namespace are
protected by their SQL source references.

For local D1/R2, replace `--database` and `--blob-dir` with the **existing local
state directory** used by Wrangler, for example:

```sh
pnpm assets preview --worker-state apps/api/.wrangler/state --before 2026-10-01T00:00:00.000Z
pnpm assets retire --worker-state apps/api/.wrangler/state --before 2026-10-01T00:00:00.000Z --id ASSET_ID
pnpm assets sweep --worker-state apps/api/.wrangler/state
```

Remote bindings are disabled. The local proxy may create emulator bookkeeping
when given a new path, but maintenance refuses a missing or older Unity schema.
Production D1/R2 cleanup is not implemented.

The Node image includes `assets-cli.js`. With the supplied Compose volumes:

```sh
docker compose exec hub node assets-cli.js preview --database /data/unity.db --before 2026-10-01T00:00:00.000Z
docker compose exec hub node assets-cli.js retire --database /data/unity.db --before 2026-10-01T00:00:00.000Z --id ASSET_ID
docker compose exec hub node assets-cli.js sweep --database /data/unity.db --blob-dir /data/blobs
```

The image's operator commands support Node storage; Wrangler is a development
dependency and is not shipped in the production image.

## Reference and race guarantees

All historical revision attachments, immutable original-source records and sync
outbox frames prevent retirement, including acknowledged jobs. Removing an asset
from the current revision does not free its historical bytes. Cleanup does not
erase cards, revision history, provenance or sync receipts.

SQL serializes retirement against new references. If attachment commits first,
retirement fails. If retirement commits first, later attachment and upload
completion fail, and normal asset lookup no longer exposes the record. Failed
card/source/outbox operations roll back their transaction.

Object storage and SQL do not share a transaction. An upload already in progress
can publish physical bytes **after** a sweep. Those bytes cannot become readable
through the asset service or regain a SQL reference, but they occupy storage until
another sweep. Stop admitting uploads and let in-flight uploads finish before a
final sweep; restart every complete sweep from the beginning. The ledger retains
every retirement forever and intentionally has no permanent deletion-complete
flag. `removed` reports that attempt, not a promise that a delayed writer cannot
recreate the object. No object is deleted merely because upload completion failed.

Migration 9 dates pre-existing assets at migration time. They become eligible no
sooner than 24 hours later; it does not invent historical creation dates. New
assets receive immutable SQL creation timestamps. Use consistent host clocks and
retain matching database/blob backups. Retired IDs and storage keys cannot be
reused through the store.

## Remaining work and evidence

This tool covers final objects with Unity asset rows. Crash-left temporary
uploads, provider cleanup failures outside this ledger, objects with no SQL row,
browser storage reclamation and remote R2 lifecycle policies remain open. No
directory or bucket scan infers that unrecognized files are safe to delete.

Six maintenance requirements run against native SQLite and local D1; root
`pnpm test` generates `runtime/asset-maintenance-conformance.md`. Filesystem/local
R2 tests cover real deletion, preserved referenced bytes, partial failure, lost
delete acknowledgments, delayed publication and repeated sweeps. CLI tests run
separate Node processes against persisted SQLite and local D1/R2 fixtures. All
fixtures are disposable synthetic data; no live Archive data is accessed.
