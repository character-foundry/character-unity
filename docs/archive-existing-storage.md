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
uses a path-derived instance ID until writer setup persists that same ID. The first
writer does not invalidate references created through the earlier read-only attachment.

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

## Reference identity index

`GET /api/archive/v2/cards/:id?version=VERSION_ID` resolves that exact version,
never silently the latest. Unregistered legacy versions are checked by their
file fingerprint; if another writer changes the accepted files before history is
registered, the old pin is explicitly unavailable.

`GET /api/archive/v2/identity?fileHash=SHA256&contentHash=SHA256&name=NAME`
checks exact container bytes before Foundry content identity, including verified
asset digests and the extracted portrait. Equal content does not merge upstream
source records. New and changed scrapes maintain these small metadata indexes in
the same Archive database. Reading never initializes or fills the index.

The old corpus has no existing file/content hash index. Read-only attachment can
inspect at most 32 matching-name legacy candidates, but a partial miss is not
proof of absence: `complete:false` and `unresolved` report that limitation. Unity
must not silently create another card on an incomplete miss. A separately
approved, coordinated writer can build only this metadata index, one bounded
batch at a time, without copying the corpus or changing originals:

```sh
UNITY_ARCHIVE_MODE=existing \
UNITY_ARCHIVE_DATABASE_PATH=/path/to/existing/cards.db \
UNITY_ARCHIVE_FILES_DIR=/path/to/existing/static \
UNITY_ARCHIVE_OBJECT_DIR=/path/to/existing/unity-objects \
pnpm --filter @character-unity/archive identity --limit 16
```

The JSON result gives `processed`, `unavailable`, `nextAfter` and `complete`.
Pass `--after CURSOR` with the same configuration to resume; a batch accepts at
most 100 versions (default 16), then exits. A completed pass can be restarted to
pick up metadata changes. This command is an explicit Archive writer operation:
the existing optimizer/worker takeover safeguards apply, and it cannot run
alongside the already-open Unity writer. It does not start ingestion, scheduling,
embedding or LanceDB work. No live corpus indexing has been authorized or run.

Versions with unsupported/missing assets retain a null content hash and an
explicit reason; no placeholder identity is invented. Their actual parsed card
name is indexed too. Because names are part of Foundry content identity, an
unresolved differently named card does not block an unrelated import after the
index has been fully attempted. An unresolved same-name candidate still makes a
content miss incomplete. Exact byte matches remain usable independently.

## Saved library cards in the same search index

Saved Unity-owned cards and Archive forks have a durable search outbox in the
Unity database. References, favorites and reads enqueue nothing. Each committed
head change records its exact revision and a monotonic event sequence atomically;
deletions enqueue a fenced tombstone. No original card or asset bytes are sent to
the search writer—only a bounded text/metadata projection.

Delivery is explicitly opt-in: set `UNITY_ARCHIVE_LIBRARY_INDEX=1` on both the
local Unity API and Archive processes, provide the matching Archive admin token,
and configure the matching document/query embedding provider. The Archive owns
the writes in its existing Lance directory, not another index directory or corpus
database. A missing/incompatible document provider leaves upserts pending rather
than acknowledging an unembedded saved card. Deletes remain deliverable without
embedding calls. Existing writer-ownership/takeover requirements still apply;
enabling this against the live installation is not part of the synthetic checks.

Save does not await embedding. Successful committed mutations wake bounded
16-entry delivery batches; fresh bursts continue through clean queued work without
an idle timer. Startup attempts one bounded batch only. A failure is retained with
its message and is not retried by polling or by browsing/favoriting a card.

Authenticated owners can inspect
`GET /api/workspaces/:workspaceId/search-index` and explicitly retry through
`POST /api/workspaces/:workspaceId/search-index/retry`. Status includes enabled/
running/pending/failed, configuration reason and the last pending error. Counts
are a bounded sample of up to 100 jobs (`bounded:true` signals that cap). Retry
drains that owner's workspace in bounded batches until clean or a failure; it
does not obtain another account's mutation authority. Disabling delivery never
discards pending jobs. Native Archive search combines the original corpus with
workspace-scoped owned-card projections, and later saves replace their old head.

The supplementary table is `unity_library_search_v1` in that same Lance directory.
Its model/dimensions are validated on every successful open; incompatible tables
are never silently reused or rebuilt. Durable delete rows prevent older deliveries
from restoring deleted results, including across multiple hosts and restarts.
The native proxy filters deleted library hits while delivery is pending and
preserves upstream offsets and excerpt/score alignment. Such pages report
candidate counts, not a complete count of live library entries.

The native Archive page shows indexing configuration, pending/failed counts and
explicit Refresh/Retry controls. It does not poll. Successful startup delivery is
limited to 16 entries; use Retry for a larger persisted backlog. The browser never
chooses a workspace scope or receives the admin credential: the authenticated Unity
host supplies that scope to Archive. Uncredentialed read-only attachment continues
to browse original Archive cards without private Unity projections.

## Search and idle behavior

The unified `/archive` page has explicit Lexical, Boolean, Semantic, Hybrid and
Filters-only modes. Provider/model/dimension availability and known or unknown
vector coverage are shown before submission. Missing/incompatible capabilities
and provider errors remain visible; the UI never substitutes lexical results for
a requested semantic query. Typing makes no embedding request. Search, Refresh
and Load more are explicit actions.

Typed filters and supported ordering use the existing indexed fields. A blank
query with a typed filter requires Filters-only mode; it cannot silently ignore
the filter. Mode, query and filters survive URL navigation/reload. Paging carries
a snapshot receipt covering query, index generation and ranking; changed inputs,
generations or candidates require a fresh first page. Match excerpts/scores stay
aligned with their result card. Semantic/hybrid totals are bounded candidate
counts, not estimates of the full Archive match count.

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
