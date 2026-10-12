# Archive read contract v1

Internal implementation contract, 2026-10-11. Version: `unity.archive-read.v1`.
This is an app boundary, not Foundry's public federation protocol. It serves
metadata and accepted source bytes; it does not parse card content, compute
canonical card identity or insert lineage.

## Run the fixture

```sh
UNITY_ARCHIVE_MODE=fixture pnpm dev:archive
```

The default mode is `off`: process health succeeds but read routes report 503.
Fixture mode owns three synthetic JSON originals and metadata in memory. It
does not inspect filesystem paths or open any Archive/Unity database. Unknown
mode values fail startup. The host binds loopback by default; authentication
and exposing this service outside a trusted local environment remain future work.

## Routes

All routes are GET under `/api/archive/v1`. Hono also supports HEAD for these
reads. Other methods and old config, sync and inbox paths are not mounted.

| Route | Query | Result |
|---|---|---|
| `/status` | — | Version, Archive ID, snapshot, source mode (`fixture` or `copy`), card count, optional search/browse/semantic capabilities, typed filter fields and supported orders |
| `/cards` | `q`, `provider`, `tag`, `limit`, `snapshot`, `cursor` | Bounded metadata page and next cursor |
| `/search` | `mode`, `text`, `semanticRatio`, `rrfK`, `filter`, `provider`, `tag`, `sort`, `limit`, `snapshot`, `cursor` | Copied-index text, browse or semantic/hybrid results, aligned scores and exact total; requires configured index |
| `/cards/:id` | Required `snapshot` | One card's metadata, original descriptor and assets |
| `/manifest` | Required `snapshot`, repeated `id` | Exact selected cards, sorted by ID |
| `/originals/:sha256` | Required `snapshot` | Exact existing original bytes |
| `/assets/:sha256` | Required `snapshot` | Exact existing asset bytes |

Card IDs and Archive IDs are opaque ASCII identifiers (1–128 characters).
Object descriptors contain `algorithm: "sha256"`, a lowercase 64-digit digest,
byte length and media type. Metadata includes title, tags and source provider,
source record ID and source URL. The URL is provenance only and is never fetched.
The tuple `(archiveId, card.id, original.hash)` identifies the accepted source
root for future imports. It is separate from edited-card content identity.
An asset is explicitly `available` with a descriptor or `unavailable` without one.
Missing objects return 404; no read downloads, repairs or creates one.

An asset may also declare an optional `binding`: `{kind: "portrait"}` for the
source portrait (including `ccdefault:`), or `{kind: "uri", uri: "..."}` matching
an exact URI in the source card's asset descriptors. The binding is included in
the snapshot. It supplies a loss-preserving import relation, not a URL-fetch
instruction. Legacy descriptors without bindings remain readable; import only
accepts such available assets when their bytes already occur in the container.
Unavailable assets remain explicit and are never fetched to repair a source.
See [the import contract](archive-import.md).

## Stable selection and pagination

The fixture captures independent copies of every descriptor and byte array at
construction. Its snapshot is SHA-256 of the version, Archive ID and validated
metadata in ID order; the metadata includes every available object's digest.
This internal snapshot digest is not a Foundry content hash. Reordered input cards
give the same snapshot; metadata/asset ordering inside a card remains significant.

The first list call may omit a snapshot. Continue using its returned snapshot,
cursor and the same filters. A cursor binds the snapshot, filter tuple and offset.
Page size may change, but is always 1–100 (default 50). Results use binary ID
ordering, not a machine's locale. Fixture search is a case-insensitive substring
match against title, source record ID and tags; provider and tag filters are exact.
It does not claim LanceDB or existing Archive search parity. A separate optional
`GET /api/archive/v1/search` endpoint now serves lexical/Boolean queries over a
validated copied Lance index. Status advertises `search: "lance-fts-v1"` only
when configured. Current copies also advertise filter-only browsing and their
supported numeric/date orders. Mode, text, exact metadata filters, sort, score/total and
snapshot-bound cursor rules are specified in [copied search](archive-search.md);
it does not reinterpret `/cards?q=`. [Semantic/hybrid search](archive-semantic-search.md)
requires an explicit copied vector table and configured query provider; it adds
aligned match excerpts and result-bound pagination.

`select` accepts 1–100 unique IDs and returns those exact entries from that
snapshot, or fails the entire request. Missing or duplicate IDs never produce a
partial manifest. A changed source returns 409 for an old snapshot; callers must
reselect explicitly. The client also verifies Archive/snapshot IDs and exact
membership rather than trusting a successful HTTP status. These manifests are
selection records, not signed authorization to publish or access remote objects.

## Bounds and errors

Unknown/duplicate query parameters are rejected, except repeated manifest IDs.
Metadata substring `q` is limited to 200 characters; lexical `text` to 2,048
and advanced `filter` to 4,096.
Request URLs are limited to 20,000
characters. Metadata has bounded strings, tags and asset arrays. JSON responses
must fit 8 MiB and individual originals/assets 32 MiB. The fixture additionally
limits its entire input corpus to 32 MiB and 1,000 cards.

HTTP errors use `{ "error": { "code": "...", "message": "..." } }`: invalid
input 400, oversized metadata 413, missing card/object 404, changed snapshot 409, unconfigured or failing
source 503. Unexpected internal errors do not expose exception details. The client
rejects malformed protocol responses, excess bytes and digest/length mismatches.
It never returns a partially verified original. Byte responses are attachments
with `nosniff`; returned card data is not interpreted as executable content.

## Browser read access

`UNITY_ARCHIVE_READ_ORIGINS` optionally lists exact comma-separated HTTP(S)
origins. Only GET/HEAD responses for those origins receive an allow-origin header,
including originals and assets. Snapshot/Archive headers are exposed so the
browser can verify them. Cookies are omitted by the client; wildcard origins and
credentialed CORS are not enabled. This is read access configuration for the
trusted local fixture, not hosted authentication. No origins are allowed by default.

## Remaining work

A live adapter must supply genuine read snapshots, retention/expiry semantics,
existing-asset lookups, stable search and access controls without mutation side
effects. It must pass this contract plus database/search side-effect checks on a
copied corpus. Fixture success does not establish live Archive read purity,
search parity, publication policy, account authorization or adoption readiness.
An explicit [copied SQLite source](archive-copied-source.md) now reads an isolated
manifest selection without legacy initialization or jobs. Its synthetic-copy tests
and built-server smoke pass; no live adapter or original-byte migration is enabled.
