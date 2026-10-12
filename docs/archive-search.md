# Copied Archive lexical search

Archive's read service can search an explicitly supplied, immutable LanceDB copy.
It reads a pinned table version and an existing full-text index; HTTP requests
never create an index, refresh a generation, embed text or invoke legacy jobs.
The normal metadata `/cards?q=` substring contract is unchanged.

The portable client exposes `client.search(request, signal)`. A copied source
with a validated index advertises `search: "lance-fts-v1"` in its status. Current
copies also advertise `browse: "lance-filter-v1"` and a `sorts` list containing
the supported numeric/date orders. The
read endpoint is `GET /api/archive/v1/search`:

```text
?text=silver%20AND%20NOT%20ocean&sort=relevance&limit=25
```

## Shared Archive browser

Local Architect, browser-only Architect and the Node hub use the same search UI.
Open **Browse Archive**, then choose **Card text** when the source advertises
lexical search. **Titles and tags** retains metadata substring search. Card text
accepts phrases and Boolean expressions, the existing provider/tag filters,
advanced field filters when advertised, relevance/title/ID ordering, and the
numeric/date orders supported by this copy. **Filters only** browses the indexed
selection without a text query; leaving its filters blank includes the whole
selection. The
Advanced filter input lists the fields and types supported by this copy. Applied
filters are shown beside the results. The results remain tied to their submitted
mode and order while the form is edited. Losing filter capability requires an
explicit retry; the expression stays available to clear or edit. Results show the submitted query, total matches and
number loaded. Empty card-text queries cannot be submitted.

Loading another page uses the submitted query, filters, ordering and snapshot,
even if the form has since been edited. Selections span pages and still require
explicit review before import. Submitting a new search clears the old selection
and review. A source that loses its search capability reports an error and
requires another explicit metadata search; it never silently executes another
query mode. Losing a selected field order preserves it as an unavailable option
and requires choosing another order. Losing indexed-browse capability clears the
results and requires an explicit retry.
Sources without a lexical index keep ordinary metadata browsing.

The API hosts proxy status and search through the configured Archive origin at
`/api/workspaces/:workspaceId/archive/status` and `/search`. They authorize the
workspace both before and after the remote read. Account-session revocation during that
read prevents results from being returned. The browser-only host calls the same
import service with its IndexedDB card service and the CORS-enabled read client.
No caller can supply a source URL or file path in a search request. A lost hub
session retains the current page, form and selection for same-account sign-in.
An import does not replace an existing unsaved editor draft.

## Query contract

`mode` is `text` by default. In that mode, `text` is required and limited to
2,048 characters. Plain text uses the pinned
index's native FTS behavior; double quotes delimit exact phrases. Boolean queries
support case-insensitive `AND`, `OR`, `NOT`, parentheses and implicit AND next to
an operand. Precedence is NOT, AND, OR. Quoted operator words are text. Invalid or
unclosed syntax is rejected. Parsing is bounded to 128 tokens and 32 nesting
levels. Each distinct term executes once per search, sequentially, within a
shared 15-second native-query deadline. File verification occurs before and
after the native operation and is also subject to the copy's byte bound.

Optional `provider` and `tag` use the existing exact metadata-filter semantics.
`sort` supports `relevance` (the text-mode default), `title`, `id`, and the
advertised field orders below. Title and ID ordering use binary string order;
relevance/title ties use ascending ID. AND/OR add matching term scores, and NOT has
score zero. NOT evaluates against the complete copied selection. Filtering,
ordering and page slicing happen after collecting its complete matching set;
there is no hidden top-k window that changes Boolean results or field ordering.

`mode=browse` requires empty or omitted `text`, accepts the same filters and
provider/tag constraints, and defaults to `sort=id`. It rejects relevance ordering.
This explicit mode is capability-gated and does not parse or run an FTS query.
Browse results have score zero. The client omits the default `mode=text` parameter
so ordinary lexical requests remain compatible with older read services.

The response contains the usual snapshot envelope and cards, plus aligned
`scores`, an exact `total` for this selection, and `nextCursor`. Subsequent pages
must send the same mode, text, filters and sort together with `snapshot` and `cursor`.
Page size can change and is limited to 1–100. A changed copy rejects an old
snapshot; a changed query rejects its cursor. Search results use the existing
exact-ID selection and verified original/asset download operations.

## Advanced filters

Optional `filter` is a separate, bounded expression, not raw SQL. Status adds
`filterFields: [{name, type}]` only for recognized legacy fields present in the
pinned table as UTF-8 strings, string lists, numbers or booleans. A minimal index
may support only `id`; missing or unsupported fields fail with HTTP 400. Vector
columns and arbitrary extra columns are never filterable. The portable client
validates the advertised field names, types and uniqueness.

Examples (URL-encode the expression when sending it as a query parameter):

```text
hasLorebook = true AND tokenCount >= 1200
(tags = "fantasy" OR tags = "sci-fi") AND NOT tags = "gore"
source IN ["ct", "chub"] AND tokenCount 1000 TO 2000
createdAt:2026-01-01
hasLorebook NOT EXISTS
```

The grammar supports `=`, `!=`, `>`, `<`, `>=`, `<=`, `:` as equality,
inclusive `min TO max`, nonempty `IN` / `NOT IN` lists, `EXISTS` / `NOT EXISTS`,
parentheses and `NOT`, `AND`, `OR` in that precedence. Unlike card-text queries,
filter conjunctions must be explicit. `token_count` aliases `tokenCount`, and
`platformSummary` aliases `platform_summary`. Single and double quotes delimit
values; a backslash escapes the next character. Apostrophes in values are escaped
before compiling to Lance SQL; unknown fields and syntax are rejected.

Scalar string comparisons and ranges are case-insensitive. String-list equality
means membership; list `IN` means any member. As in the legacy compiler, list
literals are lowercased and compared against stored elements, which must already
be normalized for case-insensitive membership. The reader does not rewrite them.
Date strings compare lexically; use consistently formatted ISO dates in a copy.
`EXISTS` means non-null, not nonempty. SQL null semantics apply: negating a
comparison against a null value does not select that row; use `NOT EXISTS`.

Numeric values must be unquoted finite decimals within the JavaScript safe-number
range; booleans must be unquoted `true` or `false`. Boolean and list ordering or
ranges are rejected. This is deliberately stricter than legacy implicit native
coercion. String ordering also consistently lowercases both sides; legacy
inequality comparisons lowercased only the literal.

Limits are 4,096 characters, 256 tokens, 32 nesting levels and 64 list values.
A nonempty card-text query remains required in `mode=text`; use `mode=browse`
for filter-only browsing or the whole indexed selection. The predicate constrains every term query and the complete universe
used by card-text `NOT`, before total calculation, ordering and pagination. The
entire filter is bound into the cursor. It shares the 15-second native deadline
with text queries. Neither filtering nor capability discovery creates an index.

## Numeric and date ordering

Only orders listed in status `sorts` are accepted. A date column must be UTF-8;
a numeric column must have an Arrow integer or float type. Missing or wrongly
typed fields are not advertised, and requesting their orders fails with HTTP 400.
Names and field mappings come from the pinned legacy Archive `SORT_MAP`:

| Orders | Indexed column |
|---|---|
| `new`, `old` | `lastModified` (descending / ascending) |
| `create_new`, `create_old` | `createdAt` (descending / ascending) |
| `tokens_desc`, `tokens_asc` | `tokenCount` |
| `most_stars_desc`, `most_stars_asc` | `starCount` |
| `most_favs_desc`, `most_favs_asc` | `n_favorites` |
| `most_msgs_desc`, `most_msgs_asc` | `nMessages` |
| `most_chats_desc`, `most_chats_asc` | `nChats` |
| `overall_rating_desc`, `overall_rating_asc` | `scoreComposite` |
| `trending_desc`, `trending_asc` | `scoreVelocity` |
| `engagement_desc`, `engagement_asc` | `engagementScore` |
| `fresh_engagement_desc`, `fresh_engagement_asc` | `engagementVelocity` |

The suffixes specify descending/ascending order. For these 22 orders, tied rows
use ID in the same direction as the primary field, matching the legacy map.
Nulls sort last in both directions. Empty strings are values, not nulls. Dates
sort as stored strings; consistently formatted UTC/ISO values are needed for
chronological ordering. The reader does not normalize stored dates or numbers.
Numeric sorting is performed by Lance and does not convert integer columns into
JavaScript numbers.

The adapter projects the sort field alongside ID and obtains the full filtered
order before choosing a response page. Text/Boolean matches and exact metadata
filters are then intersected with that order. Field sorting therefore applies to
Boolean expressions as well as plain text, and never selects a relevance top-k
window first. The full-set work remains bounded by the 10,000-card copy limit.
This differs from legacy's Boolean branch, which ignored its requested field
order. Defaults are explicit: relevance for text, ID for browse; legacy's default
`new` order can be requested when available.

## Supplying an index

An optional `search` field extends `unity.archive-copy.v1`:

```json
{
  "search": {
    "path": "search.lance",
    "table": "cards",
    "version": 2,
    "files": [
      { "path": "cards.lance/_versions/1.manifest", "sha256": "ACTUAL_FILE_SHA256" }
    ]
  }
}
```

This is a shape example: `files` must list **every actual file** below the copied
Lance directory, with real SHA-256 digests. Filenames and table versions depend on
the supplied index. Do not copy this example as a usable manifest. Paths are
relative to the explicit copy root and index root respectively; symlinks, hard
links, unlisted files/directories and path traversal are rejected. The current
bound is 4,096 files and 512 MiB of index bytes, with at most 8,192 file/directory
entries and 16 directory levels.

The table must have UTF-8 `id` and `searchText` columns and an existing FTS index
on `searchText`. Use a positional index for phrase search. Its pinned version
must contain exactly one row for each selected card, with no missing or extra
IDs; the copied-selection limit remains 10,000. A full legacy index cannot be
attached to a smaller selection. Prepare an isolated matching index separately.
Tokenization, language/stemming and accent behavior come from that supplied
index; this reader does not rebuild or reinterpret its configuration.

Startup checks the entire file inventory and hashes, schema, index and ID set.
Each search verifies all copied index bytes before and after opening the pinned
version. Handles close after the operation, including errors. Keep the copy
quiescent and mount it read-only. Missing or changed files fail closed instead of
falling back to substring matching. Sources without an index return unavailable
for `/search`; their existing list/select/download routes still work.

The complete copy manifest, including search version and inventory, contributes
to the Archive snapshot. The normal reader does not discover active-generation
pointers or create a new index. Original files and SQLite queues remain untouched.
This implementation intentionally favors explicit integrity checks over large
corpus throughput; measure and redesign the copy verification boundary before
lifting these bounds.

## Verification and remaining ports

`apps/archive/src/search.test.ts` exercises the native adapter through the real
Hono app and portable client: phrases, Boolean precedence, complete NOT sets,
filters, sorting, cursor mismatch, persisted reopen, changed files, malformed
responses and exact-original selection. A 150-row case proves that positive
term sets are not truncated to the 100-row response limit.

Native ordering tests independently specify the expected rows for all 22 legacy
orders in text, Boolean and browse modes, including ties, nulls and cursors. A
150-row case proves that a highest-valued match outside a relevance top-k window
can be returned on the first page. Incorrectly typed sort columns fail closed.

The native process and Archive container rehearsals now include this read API,
including numeric ordering, indexed browsing and continuation after restart.
The container runs the copied service with the whole data volume mounted
read-only, repeats lexical/Boolean paging after replacement, and verifies the
full file inventory and queue sentinels remain unchanged.

Native filter tests exercise the legacy grammar against real Lance rows, including
nulls, quoted apostrophes, injection-shaped literals, ranges, aliases, list
membership and filtered NOT. HTTP checks cover query-bound paging and malformed
inputs; every copied byte is inventoried before and after. The 150-row test also
checks filtered positive and NOT sets beyond a response page.

API integration tests additionally cover workspace isolation, mid-read session
revocation, advanced filters, request allowlists and exact imports selected across pages. Nine
Chromium workflows use a real, disposable SQLite/Lance copy: all three editor
hosts exercise paging, query/order/filter retention, reviewed imports, exact bytes,
failed syntax and draft preservation; the hub also reauthenticates mid-pagination.
Additional workflows cover filter-only browsing, numeric/date order, order
retention across pages and exact reviewed imports. Capability tests cover absent
and withdrawn search/filter/browse/order capabilities without silent fallback.
Desktop and 390-pixel mobile layouts are reviewed. After browser shutdown, the
root check verifies that the fixture database, originals and complete Lance
inventory are unchanged; `runtime/e2e-archive-rehearsal.json` records that result.

This ports the lexical/Boolean read boundary, using the grammar and score
combination rules inspected at legacy Archive commit
`b99dcd1201f136fcbf71b4e8f1f3ec2d217c57b0`,
`backend/services/search/{boolean-query,lance-filter,LanceSearchBackend}.js`.
Opt-in [semantic/hybrid search](archive-semantic-search.md) now adds a copied
vector table, explicitly configured query embeddings and matched excerpts.
[Explicit generation](archive-generations.md) now builds a separate copy
from prepared SQLite metadata with a fixed scoring date; the semantic command
also builds whole-card vectors through an explicitly configured provider. Full search parity needs
real-corpus comparison and those remaining ports. The
[Worker profile](worker-profile.md#archive-reads-and-imports) now supports an
explicit Archive origin, with copied-source reads/imports exercised in local
workerd and actual Wrangler HTTP/browser rehearsals.
No live Archive path or index has been opened.
