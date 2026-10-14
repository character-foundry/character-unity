# Bringing chat-app text edits back

On a local host, open a card's **Where it lives** panel, check its copies, and
choose **Review text edits** on an edited copy. The review shows the changed
fields before anything is saved. **Import as private fork** creates an owned
fork; it does not overwrite the library original, its Archive version, the
remote copy or any chats. Cancel and Escape leave everything unchanged.

The supported fields are name, description, personality, scenario, first and
alternate/group greetings, example messages, creator/notes/version, system and
post-history instructions, and tags, where the application returns them.
Only fields changed remotely since the tracked base are applied. Newer,
unrelated library edits survive; competing changes to the same field require a
manual merge.

The source portrait, bound files, lorebook, opaque data and original root stay
with the fork. Changed asset descriptors, lorebooks, extensions, lineage or
unknown authored fields in the returned JSON are refused rather than discarded.
This is text sync, not a complete remote-card/container import: out-of-band
avatar files, attached world books and application-only resources are not fetched
or imported. Use that application's complete export for those changes.

SillyTavern returns a wrapped card; field-based applications expose a partial
projection. Missing fields in a partial projection are retained from the source,
not treated as deletions. Lumiverse's documented row bookkeeping stays in that
application, and its known lorebook/version extension mapping is checked against
the source. Unknown future fields fail closed. The mapping is based on
[its character type](https://github.com/prolix-oc/Lumiverse/blob/main/src/types/character.ts)
and [card parser](https://github.com/prolix-oc/Lumiverse/blob/main/src/services/character-card.service.ts).

Each review pins the exact response-byte digest, tracked base revision, current
head and connection configuration version. Acceptance rereads and rechecks them;
changed bytes or connection details require another review. Raw remote response
bytes are not retained as another archived original; the fork keeps its existing
source root and records the digest and tracked base/head provenance. Fork creation
checks the expected head, connection version and tracked placement atomically.
A dedicated, workspace-scoped receipt table commits
with the first save, so retries and simultaneous acceptance return the same fork.
That once-per-snapshot receipt remains after its fork is removed. Accepting the
same snapshot again—even after a fresh review—returns an explicit conflict
explaining that the previous import was removed; it does not silently recreate
or restore the fork.
Authored JSON—including legacy receipt-like local fields—is never indexed or
treated as authority. The receipt is generated through an internal capability,
never accepted from uploaded files or
editor JSON; ordinary edits retain the genuine stored receipt, and later forks
get a new identity. Foundry removes this local provenance on export/publication.

Checks cover the service and HTTP interfaces, SQLite and local D1 simultaneous
acceptance, all three adapters, Archive references, asset reuse, stale reviews,
conflicts and forged receipts. The native browser test uses a separate loopback
SillyTavern-shaped HTTP service and exercises desktop/mobile review, cancellation,
stale-snapshot failure and private-fork navigation. No live application or Archive
data is used by these tests.
