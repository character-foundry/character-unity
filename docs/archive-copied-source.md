# Copied Archive read source

Archive has an explicit `copy` mode for an operator-prepared, quiescent selection
of a legacy SQLite database and accepted files. It reads the legacy schema directly
with a separate read-only connection. It never imports the legacy initializer,
runs migrations, follows database filesystem paths, starts jobs or writes queues.
An optional explicit copied Lance index enables [lexical and Boolean search](archive-search.md);
it is never discovered or built by read requests. Architect and hub continue
using the same versioned read client.

This is preparation for adoption. Tests use synthetic databases containing the
legacy table projection and mutation sentinels; no live database or real corpus
has been copied or opened by this work. Source inspection used Archive commit
`b99dcd1201f136fcbf71b4e8f1f3ec2d217c57b0`, especially `backend/db/schema.js`,
`backend/db/connection.js` and `backend/services/CardMetadataService.js`. The
legacy initializer enables WAL and performs schema/queue maintenance, so it is
intentionally outside this read path.

## Explicit input

The directory must contain `copy-manifest.json` and an independently prepared
standalone SQLite copy. The manifest selects exact database card IDs and maps
existing files. There is no automatic discovery of legacy directories.

```json
{
  "version": "unity.archive-copy.v1",
  "archiveId": "my-archive-rehearsal",
  "database": { "path": "archive.sqlite", "sha256": "REPLACE_WITH_THE_COPIED_DATABASE_SHA256" },
  "cards": [
    {
      "id": "123",
      "original": { "path": "cards/123.png", "mediaType": "image/png" },
      "assets": [
        { "id": "456", "file": null },
        {
          "id": "457",
          "file": { "path": "assets/457.png", "mediaType": "image/png" },
          "binding": { "kind": "uri", "uri": "https://example.invalid/exact-source-uri.png" }
        }
      ]
    }
  ]
}
```

The example digest must be replaced with the lowercase SHA-256 of the copied
SQLite file. Paths are relative to the copy root. Absolute paths, traversal,
symlinks and hard-linked files are refused. A database row's `localPath` is never
used to open a file; its URL is never fetched. A binding must describe the accepted
card's actual asset relation, not merely a similar filename. The existing importer
verifies bindings and rejects unused or missing bytes.

Every cache record belonging to a selected card must appear exactly once. Use
`file: null` for unavailable bytes. A non-null mapping whose file is missing fails
startup; it is never repaired. Original files are required and read exactly as
mapped, including historical downscaled/generated files accepted as the baseline.
Metadata sidecars do not replace an accepted PNG/CharX unless that choice is made
explicitly in a reviewed adoption manifest. Unselected database rows are not
exposed; the reported card count is the manifest selection size.

The copied database must use rollback journaling in its SQLite header and have
no WAL, SHM or journal sidecars. The adapter checks this before opening SQLite:
read-only access to a WAL database can still need shared-memory infrastructure.
A raw copy of a live WAL database is not a prepared standalone snapshot. Creating
and reconciling a real source backup remains a separately scheduled adoption step.

## Run

After preparing an isolated copy:

```sh
UNITY_ARCHIVE_MODE=copy UNITY_ARCHIVE_COPY_ROOT=/absolute/path/to/prepared-copy pnpm dev:archive
```

The mode requires an explicit root and a loopback listener. The default remains
`off`; fixture mode remains available. Configure the existing exact read-origin
allowlist for a static Architect client when needed. Hosted authentication and
remote exposure are still outside this local rehearsal profile.

Startup hashes the manifest and copied database, reads selected metadata in a
read-only SQL transaction, hashes mapped objects and closes the connection. It
checks the database digest again before serving. `cards.name`, `card_tags.tag`
(binary normalized-tag order), and the source tuple populate the read contract.
Source record ID uses `sourceId`, then `sourcePath`, then `fullPath`, then the
card ID when earlier values are null. Null source providers become `unknown`;
no upstream URL is inferred. Schema mismatches or incompatible metadata fail
explicitly instead of running migrations or truncating fields.

The service owns its metadata snapshot. Its token includes validated metadata,
object digests and the manifest/database fingerprints. Unchanged copied inputs
produce the same snapshot on restart. Editing even nonselected database data or
manifest bytes changes the fingerprint on the next open. Running reads do not
refresh metadata. Each object download reopens the explicit mapped file, bounds
its size and verifies its hash before returning bytes. Changed/missing objects
fail; a restart and new selection are required to use a changed copy.

The implementation supports at most 10,000 selected cards, a 1 GiB copied database,
8 MiB manifest, 64 MiB captured card metadata and 32 MiB per object. It hashes
objects without retaining all byte content in memory. JSON responses are bounded
to 8 MiB; oversized pages return 413 and can be retried with a smaller limit.
Search currently shares the fixture's deterministic title/source-ID/tag substring
semantics. It does not claim legacy SQL, Meilisearch or LanceDB search parity.
The separate [native runtime rehearsal](archive-native-runtime.md) validates
SQLite/LanceDB installation and restart with synthetic files; it does not mount
Lance search in this read adapter.

## Evidence and next work

Five copied-adapter tests cover exact bytes/provenance, unavailable assets,
pagination/filtering/selection, unchanged database/files and queue rows, changed
objects, manifest/database integrity, rollback versus WAL databases, missing
manifests, unexpected sidecars, escaping/symlink/hardlink paths and malformed/foreign cache mappings.
An API integration case imports a copied selection, edits it in Unity, retains
its source tuple and proves copied SQL and original bytes remain unchanged. The
built-server smoke command starts a separate copied-mode process with temporary
data and checks its actual HTTP responses and database bytes. Shared protocol
checks continue to cover the fixture service; a separate case checks server and
client behavior for oversized JSON pages.

A real copied-corpus rehearsal, complete metadata/cache reconciliation, scalable
search and LanceDB parity, immutable object adoption, ingest/scraper ports,
retention/expiry, backup/rollback and single-writer cutover remain outstanding.
This read adapter alone does not establish production adoption readiness.
