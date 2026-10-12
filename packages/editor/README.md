# Mountable editor

`createEditor(initial, { save })` creates an independent draft controller.
`CardEditor` renders that controller; import `@character-unity/editor/styles.css`
for its form styles. Each mount owns its state and subscriptions. There is no
application singleton, network client, database or SDK implementation here.

```tsx
const editor = createEditor({ revisionId: revision.id, document: revision.document }, {
  async save({ revisionId, document }) {
    const saved = await host.save({ expectedHead: revisionId, document });
    return { revisionId: saved.id, document: saved.document };
  },
});
// Keep this controller stable for the lifetime of the draft.
<CardEditor editor={editor} />
```

The host owns authentication, routing, persistence, lineage and card identity.
Opening a controller neither normalizes the document nor invokes save. Edits only
change whitelisted field paths. Missing defaults are displayed without being
written; null or incompatible values remain opaque. Snapshots are owned/frozen,
and the host receives a separate copy on save. Inputs lock while saving. A failed
save keeps the draft and expected head; explicit discard restores its baseline.
Discard does not fetch the latest remote revision: close and reopen to do that.
Hosts must preserve dirty drafts when navigating or obtain explicit discard.

An optional `history` port exposes `list(options, signal)` and
`read(revisionId, signal)`; see `EditorHistoryPort`. Supplying it enables **History**,
with saved-versus-draft comparison and a paginated revision list. Reads never change
the controller's draft, expected head or save lifecycle. The host enforces access;
the view cancels stale requests and owns copies of returned snapshots. Comparison
is structural display only, with unknown fields retained and lineage metadata
available separately. See [history](../../docs/revision-history.md) for the contract.

Core CCv2/CCv3 field forms and embedded lorebook editing are implemented.
`editor.editLorebook(...)` applies explicit book/entry operations to the same owned
draft and shares its save/discard/error lifecycle. Entries are addressed by array
position, preserving duplicate/missing imported IDs. Copy allocates a fresh ID and
deep-copies nested metadata; moving preserves insertion order. Unsupported field
shapes stay opaque, and no book is created until requested. Search and selection
belong to each view instance. Standalone lorebook imports and AI remain staged.

The field metadata comes from
Character Architect's MIT-licensed project at commit
`ceb138e769470f104851f34869c1fb058c50d11b`, path
`apps/web/src/features/editor/config/field-definitions.ts`; the app-specific type
import and path mutation helpers were replaced. Legacy AI/template/token flags
are retained as metadata, not implemented actions. See [the port matrix](../../docs/editor-port.md)
for features still to move. Browser-only persistence is provided by the host adapter.
Tokenizer/AI ports and the corresponding views remain acceptance gates.

The optional asset port supplies saved-revision metadata, exact byte reads and
atomic document/asset saves. Each controller stages its own bindings and immutable
Blobs; failed saves retain them and discard releases them. The Assets view supports
portrait aliases and raster previews, attachment metadata/order/removal and exact
downloads without fetching descriptor URLs. See [asset revisions](../../docs/asset-revisions.md)
for lifecycle, supported formats, tests and remaining media tools.
