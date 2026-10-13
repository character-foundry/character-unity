# Existing Archive storage

The in-house application uses the existing `cards.db`, static files and LanceDB
in place. The Archive module supplies the existing v2 read/admin interface and
the four scraper plugins. Unity continues to use its separate workspace database.
The separate native store and copied corpus remain development fixtures; they
are not prerequisites for attaching the owner's corpus.

## Read-only verification

Use canonical filesystem paths. The old `/home/vega/docker/character-archive`
path on this host resolves to `/mnt/samesung/character-archive`.

```sh
UNITY_ARCHIVE_MODE=existing \
UNITY_ARCHIVE_READ_ONLY=1 \
UNITY_ARCHIVE_DATABASE_PATH=/mnt/samesung/character-archive/runtime/state/cards.db \
UNITY_ARCHIVE_FILES_DIR=/mnt/samesung/character-archive/static \
UNITY_ARCHIVE_LANCE_DIR=/mnt/samesung/character-archive/runtime/state/search.lance \
HOST=127.0.0.1 PORT=9440 pnpm dev:archive
```

The reader supports active SQLite WAL and existing Lance tables. It does not
initialize legacy code, migrate tables, build indexes, fetch missing assets or
start the scheduler. Card parsing uses Foundry. It hashes requested files only;
portrait hashing streams in bounded buffers and reads at most four files at a
time. Original files remain at their existing paths. The main API connects through
`UNITY_ARCHIVE_NATIVE_ORIGIN=http://127.0.0.1:9440`.

Read-only object locations are a bounded in-memory cache. Request the card/page
again if an old object location has expired. Derived card JSON from legacy metadata
wrappers is bounded separately; it is not persisted by reads. An unadopted Archive
has a provisional path-derived instance ID; writer setup records the permanent
instance ID before persistent Unity reference adoption.

## Writer handoff

The same reader can write after a coordinated handoff. It adds versioned
`unity_archive_*` bookkeeping tables and source lookup indexes inside the existing
database, preserving the legacy card tables, numeric IDs, aliases, favorites and
accepted files. New files use an explicit content-addressed directory; matching
accepted files are referenced in place. Old files are never bulk copied.

Configure `UNITY_ARCHIVE_READ_ONLY=0`, `UNITY_ARCHIVE_OBJECT_DIR` (for example
`/mnt/samesung/character-archive/runtime/state/unity-objects`) and a shared
`UNITY_ARCHIVE_ADMIN_TOKEN` of at least 24 characters. Set
`UNITY_ARCHIVE_LEGACY_ROOT=/mnt/samesung/character-archive` to carry over the
known root/data blacklist files. These lists are parsed without changing them
and imported into the same database's blocked-record tables on writable startup.
Every scraper starts disabled; source settings and credentials live in Settings.

Writer setup refuses the old PNG optimizer triggers, a running legacy sync lease
or another Unity writer lock. It does not stop existing processes or remove
triggers. On this host, the existing API, scraper worker, search-maintenance
worker and vector worker must be coordinated before the new writer starts.
The exclusive `.unity-writer.lock` guards Unity instances; old workers do not
honor it. Verify a stale lock's owner has stopped before removing that exact lock.

New scrapes retain existing numeric IDs and source deduplication, including CT
path aliases and Chub's upstream IDs. Accepted baseline files are registered
lazily when first updated. Same file content creates no additional version or
binary copy. Version file references are retained in the same database.

## Search and idle behavior

`/api/archive/v2/cards` retains metadata filters and explicit ordering. Queries
use the existing lexical table (`UNITY_ARCHIVE_LANCE_TABLE`, default `cards`) and
its existing active-table pointer. Semantic and hybrid modes use `mode=semantic`
or `mode=hybrid`; similarity determines the default order when no explicit sort
is given. The response preserves `complete:false` for vector candidate sets.

The optional `UNITY_ARCHIVE_EMBEDDING_CONFIG` uses the existing query/document
provider configuration shape documented in `archive-semantic-search.md`. The
model and dimensions must match the existing active `vector_generations` record,
or the unambiguous `card_embedding_meta` identity when no generation is active.
The active generation selects its existing vector table. No query embeds cards,
downloads a model or creates a new generation. A missing/incompatible provider
leaves semantic search explicitly unavailable.

Lexical query text accepts words, phrases, AND, OR and NOT. Field-prefixed library
syntax is not the legacy lexical grammar; use the metadata filters. Complete
lexical results have a 10,000-candidate resource budget and return a refinement
error rather than truncating. The Archive itself has no 10,000-card limit.
Positive terms bound Boolean exclusions, so a narrow `forest AND NOT spaceship`
query does not need to load the whole corpus. Explicit semantic/hybrid modes
accept natural language, including conjunctions and quotes.
Legacy metadata lacks a portrait-presence bit; that filter is explicitly
unsupported until an availability index is implemented. It also has no downloads
count; download-count sorting is explicitly unsupported. Status advertises the
supported flags and sorts.

After a source run, bounded batches drain existing search queues and, with a
compatible embedding provider, vector queues/work items. Successful writes are
acknowledged against the source and queue revision; failed/newer work stays queued.
Existing active generation leases and unrelated generations are respected. Without
a provider, vectors remain queued. No queue consumer polls while idle.
Matching embedding digests, or exact baseline text in a verified active vector
table, reuse the existing vector for metadata refresh without a provider call.

The scheduler keeps one timer for the nearest enabled source. With every source
disabled, it creates no timer and performs no repeated database checks. Shutdown
cancels scheduling, scrapes and indexing before closing the database.

## Acceptance status

Synthetic tests cover existing-schema reads/writes, file/alias deduplication,
version retention, unchanged source inventories, queue retries/races, active
generations, model compatibility and idle shutdown. A read-only run against the
owner's 147,265-card corpus listed all four providers and verified one original
per provider against its SHA-256 without creating any bookkeeping tables. Plain
lexical search reused the existing LanceDB. Ten idle seconds consumed zero CPU
ticks after those checks (approximately 308 MiB RSS); this is a smoke measurement,
not a sustained production benchmark.

Anchored Boolean search also passed on the live corpus: `forest` returned 3,357
cards; `"forest" AND NOT spaceship` returned 3,344. The final local type/lint/test
checks passed 507 tests across 59 files, and the Archive bundle built successfully.

Live writer handoff, real-source scrapes, the actual embedding-provider connection,
crash recovery under real workloads and a longer operational observation remain
acceptance gates. Archive is not recorded as 100% complete until they pass.
