# Archive native runtime

For the current in-house deployment, use
[existing Archive storage](archive-existing-storage.md). The separate native and
copied-store/container rehearsals below describe development foundations; the
owner's corpus remains in its existing database/files/LanceDB, with new scrapes
writing there after a coordinated writer handoff.

Archive has a separate Node 24 container target. It includes `better-sqlite3`
13.0.3, `@lancedb/lancedb` 0.37.1 and `apache-arrow` 18.1.0 from the workspace
lockfile. The LanceDB/Arrow pair matches the inspected legacy Archive baseline
`b99dcd1201f136fcbf71b4e8f1f3ec2d217c57b0`. The API, Worker and browser runtimes
do not contain LanceDB. Archive's bounded copied-SQLite contract now accepts an
optional explicit copied Lance index for lexical/Boolean, filtered and ordered
reads, plus an optional pinned vector table for semantic/hybrid queries.
Installing LanceDB alone does not enable it or start indexing, scrapers,
optimizers or embedding jobs. See [copied search](archive-search.md).

LanceDB's optional OpenAI and Hugging Face clients are excluded with narrowly
scoped pnpm overrides. The rehearsal supplies small vectors directly. It needs
no model download, provider credentials, embedding daemon or external network.
An opt-in HTTP query adapter supports configured Ollama/OpenAI-compatible services
without their SDKs; see [semantic search](archive-semantic-search.md). Test providers
are synthetic and do not establish model retrieval quality.

## Build and verify

From the repository root:

```sh
pnpm bootstrap
pnpm --filter @character-unity/archive build
pnpm verify:archive-native
docker build --target archive -t character-unity-archive:foundation .
pnpm verify:archive-container character-unity-archive:foundation
```

`pnpm check` includes the native process rehearsal after building. CI also builds
and verifies the separate Archive image. Image builds start from the pinned Node
24.19.0 Debian base, install the lockfile in the build stage and stage the matching
native platform package. They copy no host `node_modules`, databases or keys.
The default Docker target remains the hub/Architect API image.

The native probe creates a new temporary synthetic SQLite copy, three exact JSON
originals, a selection manifest and an Arrow-typed Lance table. It tests:

- Copied-mode status, substring filtering, stable pagination, selection and exact
  original downloads through the actual Hono read app and portable client.
- The copied lexical API's Boolean/phrase searches, complete NOT results and
  snapshot-bound pagination, including after process/container replacement.
- Copied semantic queries with a synthetic in-process provider, best cosine
  matches, aligned excerpts, pagination and hybrid literal-title priority. The
  copied HTTP service stays semantic-disabled without explicit configuration.
- Unchanged SQLite bytes, original files and empty queue sentinels.
- Persisted FTS indexing, accent folding, a positional phrase query, provider and
  Boolean filters, a list filter containing an apostrophe, numeric sorting and
  pagination, and exact cosine search over supplied vectors.
- A new process reopening the same persisted files, with the same source snapshot
  and identical file inventory/digests after reads.

The container harness repeats these checks with separate containers and a unique
temporary volume. Containers run as `node` (uid 1000), without a network, with a
read-only root and dropped capabilities. The reopening and HTTP service containers
also mount the entire data volume read-only. It checks default-off, fixture and
copied modes over HTTP inside the container, replaces the copied-mode process,
and checks the persisted corpus/index again. Only resources created by the
harness are removed. Reports go to `runtime/archive-native-rehearsal.json` and
`runtime/archive-container-rehearsal.json`.

The bundled `native-rehearsal.js seed NEW_DIRECTORY` command refuses an existing
directory. `check REHEARSAL_DIRECTORY` accepts only its marked synthetic corpus.
These are verification commands, not data-adoption tools. Never pass live paths.

## Local service

The image defaults to `UNITY_ARCHIVE_MODE=off`, `HOST=127.0.0.1` and `PORT=9313`.
Its healthcheck checks the process; `/api/archive/v1/status` reports 503 until a
source is explicitly configured. On Linux, use host networking for the loopback
read service:

```sh
docker run --rm --init --network host --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e UNITY_ARCHIVE_MODE=fixture character-unity-archive:foundation
```

For an independently prepared copy, replace fixture mode with
`-e UNITY_ARCHIVE_MODE=copy -e UNITY_ARCHIVE_COPY_ROOT=/copy` and an explicit
read-only bind mount to `/copy`. The files must be readable by uid 1000. Keep the
loopback listener; configure `UNITY_ARCHIVE_READ_ORIGINS` for direct browser reads
when needed. See [copied input requirements](archive-copied-source.md). This
container does not discover a live Archive directory or enable remote hosting.

## Evidence limits and search port findings

The clean-image gate covers Linux amd64 and the pinned Node/dependency versions.
The staging code accepts Linux arm64, but that architecture has not been run here.
Windows, macOS, musl, ANN index training, performance under a real corpus, active
generation adoption and full legacy search parity are not
established by this three-row test. Boolean grammar and bounded complete-set
evaluation and semantic/hybrid ranking have separate native test suites;
real-corpus parity remains open.

Two query details were reproduced against 0.37.1 while building the probe:

1. With FTS plus a field sort, `limit(1)` selected the top BM25 candidate before
   field sorting. It did not select the globally highest numeric field. The
   rehearsal retrieves the complete small candidate set before comparing field
   order. Legacy `searchLexical` similarly retrieves a bounded candidate set then
   slices pages; real-corpus parity must account for that bound.
2. A scalar `orderBy(tokenCount).offset(1).limit(1).select(['id'])` query failed
   native planning with a missing `_rowaddr`/`_rowid` error. Including `tokenCount`
   in the projection passed. Preserve needed sort columns in the eventual adapter
   and test this again before changing Lance versions or query shapes.

The public `/cards?q=` contract continues to mean title/source-ID/tag substring
matching. The separate `/search` lexical endpoint requires a validated copied
index. Optional semantic/hybrid modes use an explicitly configured query provider
and a pinned copied vector table. The separate
[lexical/semantic generation command](archive-generations.md) is also included in the
Archive image. The container rehearsal builds a synthetic generation, serves it
read-only, replaces the serving container, repeats its search and exact-object
checks, and verifies that every input byte remains unchanged. It additionally
builds whole-card vectors through a synthetic loopback provider using the built
CLI, then reopens generated semantic/hybrid queries in a new container with the
data volume read-only. No production
indexing job or generation-writing HTTP route is mounted.
Real copied-corpus rehearsal, full metadata/cache reconciliation, search parity,
immutable accepted-byte adoption and a single-writer rollback/cutover plan remain
required before connecting live data.

API references: [LanceDB full-text search](https://github.com/lancedb/docs/blob/main/docs/search/full-text-search.mdx),
[LanceDB index API](https://lancedb.github.io/lancedb/js/classes/Index/),
[pnpm dependency settings](https://pnpm.io/settings). The version-specific query
findings above come from the local executable probe, not those general docs.
