# Standalone content

Content in the native navigation stores lorebook, preset and persona JSON in the
same Unity workspace database as cards. Kind is explicit on import; these objects
do not pretend to be character cards or acquire card identities. Accepted UTF-8
originals, including a BOM, are immutable and downloadable byte-for-byte.

Imports deduplicate exact bytes, then canonical JSON within the selected kind.
Unsafe numeric tokens, overflow, underflow and lexical values that would round
are refused before identity or persistence. An unsupported runtime reports that
precision validation is unavailable instead of silently parsing lossy values.
The JSON editor submits raw text and keeps refused/invalid text recoverable.

Explicit Save adds an immutable revision with expected-head conflict checking.
History exports and forks use the selected saved revision, never unsaved editor
text. Recovery belongs to its actor/workspace/content owner. Remove unlinks owned
library membership; it does not rewrite an original.

Account profiles review and share exact saved revisions with visibility, fork and
original-download policy checks. Recipient forks are private. This is native
typed-content sharing, not a new signed-card federation protocol. Browser-only
storage supports owned content but explicitly does not advertise hosted sharing.

Supported lorebook shapes have a read-only Foundry-backed preview. Other JSON,
including unsupported Risu/Wyvern lorebook shapes, remains editable raw JSON;
there is no implicit format conversion or provider execution. Archive scraper
ingestion, Archive reference membership and Lance search for standalone content
are not implemented or claimed.

See [QA coverage](qa/standalone-content.md) and [browser storage](browser-storage.md).
