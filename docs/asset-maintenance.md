# Asset retirement and cleanup

`pnpm assets` is an explicit operator tool for Unity's SQL-owned final objects.
It supports native SQLite/filesystem storage and local Worker D1/R2. There is no
HTTP deletion route, scheduled collector, remote Worker cleanup or browser
IndexedDB collector. Foundry and Archive storage are outside its scope. Separate
offline Node commands also cover reviewed crash-left temporary and orphan files.

Run normal host migration before maintenance. The commands require the current schema and
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

All historical revision attachments and original sources of a live card prevent
retirement. Removing an asset from its current revision does not free historical
bytes. Old tombstoned cards can release bytes only when no retained card depends
on them: every live fork descendant, pinned publication (including private or
non-downloadable publications) and durable sync job retains its complete fork
ancestry. Deleted intermediate forks do not break that protection. Outbox frames
remain protected even after acknowledgment. Archive metadata assets are always
excluded. Cleanup does not erase cards, revision manifests, provenance or receipts.

Both an asset and its deleted card must be older than the selected cutoff. A card
deleted today cannot release older bytes until the full 24-hour age floor passes.
Once reclaimed, a deleted card cannot be resurrected by removing its tombstone,
publishing a revision or adding a fork/outbox reference to its retired ancestry.
These fences run in the same SQL transaction as retirement/reference admission.

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

## Offline crash-left and orphan files

These Node-only commands are deliberately separate from SQL retirement. First
select the matching Unity database/blob directory and a cutoff at least 24 hours
old. `orphan-preview` returns exact physical-file review tokens:

```sh
pnpm assets orphan-preview --database apps/api/runtime/unity.db --blob-dir apps/api/runtime/blobs --before 2026-10-01T00:00:00.000Z
```

Save a page's returned JSON to a review file and inspect it. Stop the owning host
and **all storage writers**, including direct upload/adaptor processes, before
removal. `--storage-stopped` confirms that operational requirement; it does not
stop processes or acquire an application-wide lock:

```sh
pnpm assets orphan-remove --database apps/api/runtime/unity.db --blob-dir apps/api/runtime/blobs --before 2026-10-01T00:00:00.000Z --review reviewed-orphans.json --storage-stopped
```

Only generated UUID-v4 filenames directly inside `.pending/` and `assets/` are
considered. There is no recursive traversal. Every SQL-owned key, whether staged,
ready, retired or an Archive locator, is excluded; use the retirement ledger for
those. `originals/`, unknown layouts, symlinks and hard links are never selected.
Preview uses bounded memory and `--after KEY --limit 1..100`. Follow `nextAfter`
even when a page has no eligible objects: its cursor advances over examined names,
not just selected files.

Removal rechecks exact device/inode, size and nanosecond birth/change/modify times,
the minimum age and current SQL ownership. A changed file or replaced storage
directory fails without deleting it. Each result is `removed` or `failed`; an
already absent file is retryable success. Any failure gives exit status 1 and
requires review before retry. Review files must be regular, non-symlink JSON files
of at most 256 KiB. Never run these commands against Archive paths or a mismatched
backup's blob directory. Concurrent hostile filesystem mutation is outside the
trusted operator-owned directory contract; quiescence is required for orphan
removal, not inferred from an old timestamp.

Node filesystem orphan cleanup does not apply to remote R2 or IndexedDB. R2
temporary objects still need an independently reviewed provider lifecycle policy.

## Explicit browser cleanup

In the browser storage profile, open **Settings → Browser storage** and choose
**Preview browser cleanup**. Preview is read-only. Select the reviewed objects,
open the confirmation, and explicitly remove them; Cancel or Escape removes
nothing. There is no automatic or startup sweeper and no public server cleanup
endpoint.

Only local asset objects unreferenced by any live card, its full revision/source
history or recursive fork ancestry can be selected. Archive locators are always
kept. The minimum age is 24 hours since creation or the last relevant card
deletion. Legacy orphan objects without an age need a separate **Start 24-hour
clock** observation, another 24 hours, and a new preview. That observation deletes
no bytes and never resets an existing clock.

Removal rechecks the exact reviewed metadata and complete reference graph in one
IndexedDB transaction. It retains card, revision, source and asset catalog
metadata, deletes the selected local bytes, and permanently fences the retired
storage keys against late uploads or new references. A changed selection aborts
the entire batch. Repeating a confirmed removal is safe. Statistics exclude
retired objects, but reported removed byte counts do not promise an immediate
reduction in the browser's physical disk allocation.

Missing or inconsistent ready objects produce an explicit integrity error, not
an empty preview or a claimed zero-byte success. Export or back up anything you
may need before confirming removal: deleted browser bytes are not recoverable
from retained metadata alone. These controls do not inspect or remove arbitrary
IndexedDB records outside Unity's known asset catalog.

## Unity Node backup and isolated restore

Use explicit matching Unity paths and a new output directory:

```sh
pnpm backup create --database /path/to/unity.db --blob-dir /path/to/unity-blobs --output /path/to/new-backup
pnpm backup verify --input /path/to/new-backup
pnpm backup restore --input /path/to/new-backup --output /path/to/new-isolated-profile
```

Create uses SQLite's online backup API, then copies and checks every ready,
non-retired Unity-owned file against the snapshot inventory. Archive assets remain
exact-version locators in that database: no Archive originals or LanceDB are copied.
Staged uploads, untracked objects, external environment configuration and browser
preferences are not included. Quiesce uploads and cleanup during backup. Missing,
changed or concurrently swept files fail; no completion manifest is committed.

These are operator commands, not public HTTP endpoints. The database includes
private documents, account/session and chat credentials. New directories use mode
0700 and files use 0600; protect the backup as carefully as the running database.
Verification checks hashes, lengths, SQLite integrity and the complete database
asset inventory. It rejects path traversal, duplicate keys and symlinked files.
Hashes detect corruption; an unsigned backup is not an authenticity guarantee.
The newly created snapshot uses a self-contained DELETE journal, even if the live
source uses WAL. Verification refuses backup SQLite sidecars; restore never drops
undeclared WAL/journal state or changes the live database's journal mode.
The bounded format supports at most 100,000 owned assets and a 16 MiB manifest;
oversized inventories fail before any asset bytes are copied.

Restore verifies first and requires a nonexistent destination. It writes a new
`unity.db` and `blobs/`; it never overwrites, activates or migrates existing data.
Configure the Archive connection separately if inherited assets are needed. A
failed operation can leave an incomplete, inspectable directory; do not activate
it. Rehearse restore only in a disposable destination before relying on a backup.

## Evidence

Twelve maintenance requirements run against native SQLite and local D1; root
`pnpm test` generates `runtime/asset-maintenance-conformance.md`. Filesystem/local
R2 tests cover real deletion, preserved referenced bytes, partial failure, lost
delete acknowledgments, delayed publication and repeated sweeps. CLI tests run
separate Node processes against persisted SQLite and local D1/R2 fixtures, including
read-only orphan preview and refused unsafe removals. Filesystem tests exercise
review-token changes, SQL ownership races, age floors, pagination, lost deletion
acknowledgments and replaced namespaces. All
fixtures are disposable synthetic data; no live Archive data is accessed.
