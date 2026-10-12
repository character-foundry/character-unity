# Revision history and comparison

Architect's Node and static profiles and the hub share the editor's **History**
section. Opening it lists saved revisions and compares the latest saved document
with the current draft. Select another saved revision to compare against it.
History never replaces the draft, changes its expected head, saves a revision,
adds lineage, publishes anything or modifies accepted originals.

The host injects an optional `EditorHistoryPort` when creating the controller:
`list(options, signal)` returns bounded revision metadata and `read(id, signal)`
returns a full `EditorRevision`. The editor has no database or HTTP client.
Architect's browser host calls the same card service through IndexedDB; Node and
hub hosts call the shared authorized API. Each pane captures its original workspace
and card, so switching the library workspace cannot retarget a history request.

## Read API

Both routes require the workspace owner's session:

```text
GET /api/workspaces/:workspaceId/cards/:cardId/revisions
GET /api/workspaces/:workspaceId/cards/:cardId/revisions/:revisionId
```

The list accepts `limit` (1–20, default 20), `afterSequence` (default 0), and
`throughSequence` (default the current head sequence). It returns:

```json
{
  "revisions": [{ "id": "…", "sequence": 1, "authorId": "…", "createdAt": "…" }],
  "headRevisionId": "…",
  "throughSequence": 23,
  "nextAfter": 20
}
```

For the next page, pass `afterSequence=nextAfter` and the same `throughSequence`.
New saves do not enter that traversal; refresh without a boundary to include them.
`nextAfter` is null at the end. `headRevisionId` describes the head observed for
that request, which can advance independently of a pinned traversal. Duplicate or
unknown query parameters, invalid ranges and future boundaries are rejected.
List payloads omit full documents and assets. Individual reads verify both the
workspace and card before returning the immutable revision. A member/public hub
publication never grants access to an owner's private revision history.

No schema migration or new storage model was needed: SQLite, D1 and IndexedDB
already store immutable ordered revisions. The card service adds authorization
and a stable upper sequence bound around those existing reads.

## Comparison and conflicts

Comparison covers the complete document, including unknown extensions, lorebooks
and asset descriptors. Object key order is ignored; absent properties and null are
different; arrays compare by position. This is a display comparison, not a content
hash, semantic merge, asset-byte comparison or a second Foundry identity algorithm.
Lineage metadata remains available in a collapsed section. Unknown extension data
is not hidden under that section. Long values expand explicitly, and differences
page in groups of 50 without claiming omitted changes are equal.

The editor cancels replaced or unmounted reads and ignores their late results.
Refresh clears stale comparison data, with errors shown without dropping the draft.
Saving refreshes history against the new base revision. Hub session expiry locks
the workbench and allows same-account recovery with the draft intact.

If another editor saves first, refresh history to compare that newer version with
the unsaved draft. A save still checks the original expected head and fails on
conflict. **Discard changes** restores the version originally opened, not the
latest remote revision. Close/reopen after resolving or discarding the draft to
start from the current head. Automatic merging, field restoration, named snapshots
and revision deletion are not implemented.

## Evidence

Shared card-service cases run on native SQLite/filesystem and IndexedDB, covering
concurrent appends between pages, immutable reads, workspace/card authorization,
bounds and unchanged originals. HTTP tests cover strict queries, account isolation
and revoked sessions. Editor tests cover null/absence, key ordering, unknown keys,
array order, complete comparison pagination and unchanged drafts/expected heads.

Three real Chromium workflows use the built Node, static and account hosts. They
exercise saved-versus-draft comparison, saving from history, 22-revision traversal,
stale-save rejection, failed-read retry, cancellation of a delayed older read,
session recovery and exact original bytes. Desktop and 390px mobile screenshots
are inspected separately. No legacy or live Archive database is used.
