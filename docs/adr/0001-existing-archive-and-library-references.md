# Keep the existing Archive and reference its originals

Accepted by the owner, 2026-10-13. One application uses the existing Archive
database, file corpus and LanceDB for ingestion/history/search, and Unity's
database for references, favorites, saved edits/forks, new cards and sharing.
New scrapes write into the existing Archive schema, extended in that same
database where necessary; retaining roughly 200 GB of originals in place avoids
a replacement corpus and keeps source IDs, deduplication and search data intact.

Favoriting an archived original adds a library reference; the first saved edit
creates the Unity-owned fork. Unchanged originals/assets remain referenced.
File imports check Archive and Unity identities before creating another entry.
This supersedes the separate native Archive-store rollout and bulk-copy adoption
in the October 12 handover. The in-place backend, reference model and native
search controls are implemented. Live writer takeover and real-provider acceptance
remain pending; synthetic tests do not establish operational production acceptance.

References pin `(archiveId, cardId, versionId)`. Repeated adds of that pin are
idempotent; importing a newer historical version can create a separate reference
instead of opening an older pin. Unfavoriting retains library membership. Explicit
Remove unlinks membership without deleting the Archive source or saved forks.

Changed/new Unity cards have durable search outbox events. An explicitly enabled,
authenticated Archive endpoint writes bounded, workspace-scoped projections into
`unity_library_search_v1` in the existing LanceDB. It does not write originals or
introduce another authoritative corpus. The existing model and dimensions are
required; unavailable providers leave delivery retryable. Event sequences and
durable delete tombstones prevent stale deliveries from resurrecting old results.
Queries include private Unity projections only through the trusted host's
authenticated workspace scope. There is no idle polling, automatic corpus scan
or replacement Archive vector generation.

The full owner direction and acceptance criteria are in
[`1013_archive_foundation.md`](../../../1013_archive_foundation.md).
