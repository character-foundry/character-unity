# Copied Archive semantic and hybrid search

Semantic search is opt-in and stays inside the separate Archive Node service.
The API, Worker and browser packages contain only the portable read contract;
none imports LanceDB, an embedding SDK or a model runtime. Operator configuration
selects the embedding service. Callers can submit a query, never a provider URL,
key, model, table name or vector.

## Copy and embedding space

A copied search manifest can include a second pinned table under the same fully
inventoried Lance directory:

```json
{
  "search": {
    "path": "search.lance",
    "table": "cards",
    "version": 2,
    "files": [{ "path": "EVERY_ACTUAL_FILE", "sha256": "ACTUAL_SHA256" }],
    "vector": {
      "table": "card_vectors",
      "version": 1,
      "space": {
        "model": "YOUR_PINNED_MODEL",
        "dimensions": 1024,
        "sourceDimensions": 1024,
        "queryInstruction": ""
      }
    }
  }
}
```

This is a shape example, not a usable manifest. Both table versions and every file
must come from the prepared copy. The enclosing manifest is part of the Archive
snapshot. Reads verify the whole index inventory before and after opening each
pinned table; they never train an index, create a generation, optimize or repair.

The vector table requires UTF-8 `id`, `card_id`, `section`, `matchText`, and a
`FixedSizeList<Float32>` column named `vector`. Row IDs are unique and bounded;
multiple rows may refer to the same selected card. Every `card_id` must belong
to the copied lexical selection. Partial vector coverage is allowed and exposed
in status; it is never presented as complete coverage. Each vector must have the
declared dimension, finite values and nonzero magnitude.

Current copy limits are 40,000 vector rows, 4,000,000 scalar vector components,
1–4,096 dimensions, 8,192 characters per match excerpt and 32 MiB of total excerpt
UTF-8 bytes. The existing 10,000-card and 512 MiB index limits also apply. These
limits define a copied-data rehearsal boundary, not production corpus capacity.

The manifest declares the embedding space; file integrity cannot prove which
weights produced those vectors. Use a fixed model revision and record how the
copy was generated. The provider configuration must match the manifest's model,
dimensions, source dimensions and query instruction exactly. A changed or absent
space is not inferred from array length.

## Operator configuration

Set `UNITY_ARCHIVE_EMBEDDING_CONFIG` to an operator-owned JSON file when starting
`UNITY_ARCHIVE_MODE=copy`:

```json
{
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "space": {
    "model": "YOUR_PINNED_MODEL",
    "dimensions": 1024,
    "sourceDimensions": 1024,
    "queryInstruction": ""
  }
}
```

`provider` is `ollama` or `openai`. OpenAI-compatible services use
`<base>/v1/embeddings` (without duplicating `/v1`); Ollama uses `<base>/api/embed`.
HTTPS is required except for loopback HTTP. URL credentials, query parameters,
fragments and redirects are rejected. OpenAI-compatible authentication comes
from `UNITY_ARCHIVE_EMBEDDING_KEY`; it is never part of status or the manifest.
No provider is enabled by default, and no probe downloads a model or contacts an
external embedding service. A configured model may incur the operator's provider
charges when semantic queries are submitted.

One request sends `{model, input: [text]}`. With an instruction, the exact input is
`Instruct: <instruction>\nQuery:<trimmed query>`, matching legacy Archive. A response
must contain exactly one vector with `sourceDimensions` finite values. If that
number exceeds `dimensions`, the configuration explicitly opts into prefix
projection followed by L2 normalization, as used for compatible Matryoshka models.
It is the operator's responsibility to choose a model that supports projection;
there is no automatic truncation for an unexpected response size. Zero projected
vectors, changed response models and malformed response indexes are rejected.

Responses are bounded to 256 KiB, requests have a 15-second provider timeout,
and aborting a request cancels response consumption. The combined semantic
operation shares a 25-second query deadline across lexical, provider and native
vector operations; each native query is capped at 15 seconds and its remaining
budget. Before/after file verification remains bounded by the copy inventory. Errors expose no provider
body or key. Up to 64 successful query vectors are cached for five minutes in the
process; cached arrays cannot be changed through returned values. No cache is
written to Archive files.

## Read API and ranking

Status advertises `semantic: {version: "lance-cosine-v1", model, dimensions,
indexedCards, indexedRows}` only after the vector table and provider space are
validated. A copy can have a validated vector table without an enabled provider;
its normal text, filter and browse modes still work.

`GET /api/archive/v1/search` adds two explicit modes:

- `mode=semantic`: nearest cosine matches for the whole query text.
- `mode=hybrid`: plain-text lexical matches plus semantic matches. Boolean or
  quoted-phrase queries are rejected; choose card-text mode for those semantics.

Both require nonempty text, accept the same advanced/provider/tag filters and
field orders, and return aligned `matches` entries alongside cards and scores.
A match is `{section, text, score}` or null for a lexical-only hybrid result.
The best vector row supplies each card's excerpt and similarity score
`1 / (1 + max(0, cosineDistance))`. This value is not a probability.

For this bounded copy, exact flat cosine search deliberately bypasses any ANN
index. All vector rows are collected before selecting the best row per card;
many chunks from one card cannot hide another card behind a top-k window.
Equal distances use card ID then vector-row ID. Advanced filters are evaluated
against the pinned lexical table and intersected with exact metadata filters
before ranking the eligible vector/lexical sets.

Hybrid ranking ports legacy weighted reciprocal-rank fusion: semantic weight
`semanticRatio` defaults to 0.4, lexical weight is `1 - semanticRatio`, and the
rank denominator is `rrfK + rank` (one-based rank, default `rrfK=60`). The ratio
must be in [0,1], and K an integer in [1,1000]. They are accepted only for hybrid
mode. Zero-weight branches are not queried. Fusion ties preserve vector-first
insertion order. Exact title matches, title substrings and multiword title matches
then receive the same stable priority as legacy `hybrid-ranking.js`. Hybrid
scores describe fusion; the per-match score remains cosine similarity.

All supported explicit field orders override relevance ordering. The shared UI
uses the default hybrid weights; API consumers can set them explicitly. Provider
failures, changed capabilities and malformed queries report errors rather than
silently executing another search mode.

Semantic cursors bind the snapshot, all query parameters and a digest of the
complete ordered result set, scores and excerpts. Reopening with the same query
results preserves pagination. A changed embedding response after cache expiry or
restart produces HTTP 409 if it changes those results; the caller must search and
reselect. This avoids promising deterministic model output from a mutable remote
service.

## Shared UI and evidence

Both Architect profiles and the Node hub offer Semantic and Hybrid modes only
when configured. The form explains that query text goes to the provider and shows
model identity and vector coverage. Results include expandable matched excerpts.
Paging retains the submitted mode and query despite form edits. Exact selection,
review and import use the existing immutable-original flow. Withdrawing semantic
capability requires an explicit retry in another mode.

Tests cover cosine scores, opposite vectors, multiple chunks per card, partial
coverage, independent hybrid ranking examples, title priority, metadata/advanced
filters, provider cancellation and malformed data, workspace/session admission and
post-read account revocation, response validation, unchanged
copied files, and result-digest rejection after a provider change. A 152-row case
puts 150 nearest chunks on one card and proves the other cards remain pageable.
The native process and read-only Archive-container probe execute the semantic
read client with an injected synthetic provider and verify unchanged inventories
after restart. Browser workflows use a real copied SQLite/Lance source and a loopback synthetic
Ollama-compatible server; they do not establish the retrieval quality of a real
embedding model.

[Explicit semantic generation](archive-generations.md#semantic-generation) now
builds a new lexical/vector copy with serial, bounded document batches and manifest
publication after validation. Real copied-corpus comparisons, ANN recall/performance,
provider/model quality and live Archive adoption remain unverified. This reader
preserves the intended ranking rules, with explicit failure and complete bounded
sets replacing legacy fallback and candidate-window behavior. It does not claim
full legacy deployment parity.
