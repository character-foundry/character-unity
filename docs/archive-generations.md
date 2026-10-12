# Building a copied Archive generation

The operator command builds a new, immutable search generation from an already
prepared `unity.archive-copy.v1` selection. It requires the copied legacy SQLite
metadata and all explicitly mapped original/cache files. It does not discover
live data paths or import Archive's initializer, optimizers or queue workers.

```sh
pnpm bootstrap
pnpm archive:index lexical \
  --copy /absolute/path/prepared-copy \
  --output /absolute/path/new-generation \
  --as-of 2026-10-12T00:00:00.000Z
```

Use absolute paths: pnpm executes this package command from `apps/archive`.
The output parent must already exist without symlink components. The output
must be a new directory outside the input tree. Existing paths, including
incomplete prior attempts, are refused. The command creates its output with
mode 0700; the operator must arrange ownership for the separate read service.
The built Archive image includes the same command as `node generation-cli.js
lexical ...` or `node generation-cli.js semantic ...`. It needs write access
only to its new output and read access to the prepared input. Lexical builds
need no model provider or network access.

## What is generated

The command validates the complete input selection before writing, copies its
standalone SQLite snapshot byte for byte, and copies the explicitly mapped
originals and available cache files under SHA-256 filenames. Identical object
bytes share one output file. Missing cache records and explicit asset bindings
are retained. It never uses a database `fullPath`, `sourcePath`, `localPath` or
remote URL to locate or fetch an object. Unmapped files are not copied.

A new Lance `cards` table contains one row per selected card. Its positional
FTS index uses lowercase and ASCII folding, matching the inspected legacy index
configuration. All 22 numeric/date orders and the corresponding legacy filter
columns are present. The resulting manifest pins the table version and hashes
every Lance file. The ordinary read adapter validates that index before the
manifest is published. Serving the output uses the existing copy profile:

```sh
UNITY_ARCHIVE_MODE=copy \
UNITY_ARCHIVE_COPY_ROOT=/absolute/path/new-generation \
pnpm dev:archive
```

The command above is an explicit **lexical** build. An input may already contain a valid
lexical/vector index, but neither table is carried over. The result advertises
lexical/filter/order capabilities and no semantic capability. The JSON report
states `replacedSearch` and `vectorsGenerated: false`. No configured embedding
environment variables are read by that command. Use the separate semantic
command below to build vectors as well.

## Semantic generation

Use the same explicit JSON provider/space configuration as
[semantic reads](archive-semantic-search.md#operator-configuration). The file
must be a regular file without symlinks/hard links, at most 16 KiB. The command
does not discover the read service's environment configuration automatically:

```sh
pnpm archive:index semantic \
  --copy /absolute/path/prepared-copy \
  --output /absolute/path/new-semantic-generation \
  --as-of 2026-10-12T00:00:00.000Z \
  --embedding-config /absolute/path/embedding.json \
  --batch-size 32 --token-budget 24000
```

This explicitly sends the selected cards' metadata search text, including source
path fields, to that provider. For OpenAI-compatible authentication, set
`UNITY_ARCHIVE_EMBEDDING_KEY` in the process environment; it is not written into
the output or report. Ollama rejects a supplied key. The model must already be
available; Unity does not download models. There is no automatic retry, provider
fallback, queue processing, scheduling or active-generation switch.

The projection follows the **Lance** legacy pipeline at the same pinned Archive
commit, `scripts/etl_cards_lancedb.js`. It embeds one metadata-derived text per
card. The older Meilisearch section/alternate-greeting chunk pipeline is not used
by legacy Lance and is not substituted here. Input order is ascending selected
ID. Each text is the lexical `searchText` prefix of at most `tokenBudget * 4`
UTF-16 code units; lone surrogates at the boundary become U+FFFD. Documents are
not trimmed or prefixed with `queryInstruction`; that instruction applies only
to later search queries.

The budget is the legacy `ceil(text.length / 4)` estimate, **not a tokenizer**.
It accepts 512–24,000 (default 24,000). Batch size accepts 1–128 (default 32).
A batch respects both bounds, and only one request is active at a time. Choose
a budget appropriate to the configured model. Ollama document calls specify
`truncate: false`, so a smaller model context fails rather than silently losing
more text; this follows the [Ollama embed API](https://docs.ollama.com/api/embed).
An OpenAI-compatible service must implement the configured model's limits.

Both protocols must return exactly one finite vector per input. OpenAI response
indices must cover the batch exactly once; shuffled responses are restored to
input order. Dimension drift, missing/duplicate indices, zero projected vectors,
invalid JSON/model identity and provider errors fail the build. Prefix projection
is explicit through `sourceDimensions > dimensions`, followed by L2 normalization
and Float32 storage. Requests have a 120-second deadline and a 16 MiB response
bound. Query requests retain their separate 15-second/256 KiB limits and cache.

Before any model call or output reservation, the plan must fit the reader's
40,000-row, 4,000,000-vector-element and 32 MiB excerpt limits. The selected-card
limit still applies, so a 1,024-dimensional full-coverage generation can contain
at most 3,906 cards. Empty texts are counted as skipped; an entirely empty plan
fails. The plan records provider-input digests, batch count, indexed/skipped cards,
input character count and prefix/excerpt truncation counts. The ready receipt
also records a digest of the stored Float32 rows. Provider results need not be
deterministic, and digests do not attest to the provider's actual model weights.

The `vectors` table stores unique card/row IDs, `section: "card"`, vectors and
an excerpt of at most 8,192 code units. The excerpt can be shorter than the text
embedded; its truncation is recorded separately. All vector rows are written in
one table creation after every batch succeeds. The manifest pins both lexical
and vector versions and their full file inventories. Validation and source
revalidation precede publication, exactly as for lexical builds. A failed or
cancelled semantic build publishes neither table through a final copy manifest.

Serve the resulting copy with the same embedding space configured for queries:

```sh
UNITY_ARCHIVE_MODE=copy \
UNITY_ARCHIVE_COPY_ROOT=/absolute/path/new-semantic-generation \
UNITY_ARCHIVE_EMBEDDING_CONFIG=/absolute/path/embedding.json \
pnpm dev:archive
```

Without a query provider, the output still supports lexical reads but does not
advertise semantic capability. A mismatched query space fails startup. Existing
input vector tables are rebuilt, not carried over or mixed into the output.

## Projection and scoring

The application projection follows legacy Archive commit
`b99dcd1201f136fcbf71b4e8f1f3ec2d217c57b0`,
`backend/services/search-index.js::buildSearchDocumentFromRow` and
`backend/services/search/LanceSearchBackend.js::normalizeLanceDocument`.
It uses SQLite metadata, not a reinterpretation of accepted original bytes.
Those bytes remain unchanged even if their content differs from metadata.

Search text concatenates name, tagline, description, platform summary, author,
normalized topics, source, source path and full path. As in legacy, platform
summary repeats description. Indexed tags/topics come from comma-separated
`cards.topics`, trimmed and lowercased. Metadata `/cards` tags still come from
`card_tags`; these two stored representations are not silently reconciled.
Legacy aliases, defaults, feature flags and token/statistic fields are retained.
All source columns declared in `apps/archive/src/search-document.ts` must exist.
A sparse synthetic schema or unsupported legacy schema fails explicitly instead
of advertising filters populated with fabricated values.

The required `--as-of` is a canonical UTC timestamp with milliseconds. It freezes
age-dependent scores for this generation. Composite score is stars plus twice
favorites; its velocity divides by creation age, clamped to at least one day.
Engagement combines chats, messages, favorites, stars and positive rating votes,
plus the legacy freshness bonus (25 through day 3, 15 through day 7, 8 through
day 14). Engagement velocity divides by last-activity age. Missing dates retain
legacy's one-day default.

Two deliberate changes make bad inputs and host differences explicit:

- Unzoned ISO dates and SQLite timestamps are interpreted in UTC. Zoned ISO
  timestamps retain their offset; stored date strings remain unchanged for
  lexical field ordering. Invalid calendar dates or unsupported date syntax fail.
- Nonfinite/invalid numbers and source values outside the JavaScript safe-number
  range fail, rather than silently becoming zero or losing integer precision.

`generation.json` records input snapshot/manifest digest, scoring date, projection
version, row digest, counts and byte totals. The same input and date produce the
same ordered row digest across tested host timezones. Lance physical files,
version metadata and resulting copy snapshots are not promised to be byte-for-
byte reproducible. The receipt is operator information; the read boundary trusts
and validates `copy-manifest.json` and its referenced bytes.

## Publication, failures and limits

The output starts without `copy-manifest.json`. A building receipt marks the
reserved directory. After index validation and revalidation of the entire input,
the command writes a pending manifest and atomically renames it into place.
Only the final `copy-manifest.json` marks publication. Readers pointed at an
incomplete directory fail closed. A SIGINT/SIGTERM is checked between stages;
an in-flight native operation can finish before cancellation is observed.
No active-generation pointer or running service configuration is changed.

Failures leave the owned output for inspection; retry with a new directory.
No automatic deletion, source repair or rollback of operator files is attempted.
Keep the input quiescent throughout the build and mount completed copies
read-only. This is process-interruption-safe publication, not a verified
power-loss recovery protocol. A valid published manifest may exist if a final
directory sync or reporting operation fails; inspect it before choosing a retry.

Bounds are 1–10,000 selected cards, 1 GiB SQLite, 4 GiB combined SQLite and unique
objects, 1 MiB per input search row, 64 MiB projected metadata, and the existing
per-object/manifest limits. Generated indexes must fit the reader's 512 MiB,
4,096-file, 8,192-entry and 16-directory-depth bounds. These are validation
bounds, not an OS disk quota or a native-build memory/time guarantee. Raising
them requires a separate throughput and resource review.

## Evidence and remaining work

Native tests use independent expected scores and real SQLite/Lance files to
exercise phrase search, typed filters, field ordering, page continuation after
reopen, exact original/cache copies, existing-path refusal, source mutation and
cancellation before publication. Separate CLI processes compare row digests
under UTC and America/New_York. Input inventories include queues and originals.
The native/container rehearsals build a synthetic generation; the container
then serves and reopens it with the full data volume mounted read-only.

Document-provider tests cover both protocols, shuffled response indices, projection,
Unicode prefix boundaries, serial batches, malformed/cancelled results and changed
source files. Persisted generated tables pass semantic/hybrid/filtered reads and
continuation after reopen. Native process and container rehearsals run the built
semantic CLI against a synthetic loopback provider, then reopen the output in a
new process/container with unchanged bytes and pagination. The container has no
external network; no real model or paid provider is used by verification.

Real-corpus projection/search comparison, actual model quality, production-size
resource measurements, active-generation adoption/rollback and live cutover
remain unverified. This command does not satisfy those adoption gates.
