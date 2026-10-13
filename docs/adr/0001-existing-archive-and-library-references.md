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
in the October 12 handover. Implementation and live writer takeover are pending;
the prototype's tests do not establish in-place production compatibility.

The full owner direction and acceptance criteria are in
[`1013_archive_foundation.md`](../../../1013_archive_foundation.md).
