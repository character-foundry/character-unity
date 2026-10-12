# Asset revisions

The shared card service can explicitly add, replace, retain, reorder or remove
portrait and declared asset bindings while saving the edited document in the same
revision. Native SQLite and IndexedDB use the same service. HTTP routes are mounted
under the existing local-owner and hub-account authentication boundaries. All three editor hosts now inject a per-instance asset port for draft editing,
verified saves and revision-scoped reads.

An ordinary document save still preserves its existing assets. Asset changes use
`saveAssets(actor, workspaceId, cardId, expectedHead, document, bindings, uploads,
signal?)`. The caller submits the complete desired binding map:

```json
[
  { "path": "portrait", "source": { "kind": "upload", "index": 0 } },
  { "path": "declared/0", "source": { "kind": "upload", "index": 0 } },
  { "path": "declared/1", "source": { "kind": "existing", "path": "declared/2" } }
]
```

`declared/N` addresses position N in the submitted `data.assets` array. An existing
source path addresses the card's expected saved revision, allowing the destination
array to be reordered without changing bytes. It cannot reference another card,
an arbitrary asset ID, a storage key or the accepted original. Every descriptor
and upload must be bound, with no duplicate destination paths or unused uploads.
A `ccdefault:` descriptor must bind the same digest as the portrait. Multiple
bindings to one uploaded file share its stored asset record.

The service owns inputs before awaiting work, checks workspace ownership and the
expected head, verifies stored identity and lineage through Foundry, and rejects
submitted lineage changes. It validates the complete new document and bindings
before staging bytes. Foundry creates edit lineage; the final store operation
atomically checks the expected head and all ready asset references before creating
the revision. Existing account session guards also run inside that write batch.
A document-and-digest no-op creates neither a revision nor staged uploads.

Accepted originals and previous revisions stay immutable. Upload failure,
cancellation, a competing save or session revocation cannot partly advance the
card. Such failures can leave staged or unreferenced verified blobs; operational
cleanup remains outstanding. No new database migration is needed.

## HTTP contract

For a card at `/api/workspaces/:workspaceId/cards/:cardId`:

| Request | Result |
|---|---|
| `POST /asset-revisions` | Save document and complete asset bindings against `expectedHead` |
| `GET /assets?revisionId=...` | List path, digest, byte length and media type for one authorized revision |
| `GET /asset?revisionId=...&path=...` | Download that revision's exact asset bytes |

POST uses multipart form data. The `input` text field contains exactly
`expectedHead`, `document` and `bindings`. File fields are consecutive `file:0`,
`file:1`, etc., matching upload indexes. Requests cannot supply an actor. Duplicate
fields, sparse indexes, extra metadata and unused files are rejected. The complete
body is bounded before multipart parsing. Limits are 32 MiB of new bytes, 64 files
and bindings, 63 declared descriptors, a 250,000-byte document, and 64 MiB summed
across the revision's references. Aliased references count separately in that sum.
Body reading and the service operation each have a 30-second deadline.

GET requires a specific revision belonging to the requested card and workspace.
Responses expose no storage keys or internal asset IDs. Downloads use attachment,
no-store, nosniff and sandbox headers. Unknown or repeated query parameters are
rejected. Revoked sessions and other accounts cannot read private asset metadata
or bytes.

## Byte and export behavior

Uploads preserve exact bytes. Media types are metadata, not image validation.
The operation does not fetch URLs, convert images, optimize files, strip metadata
or change Foundry's hash rules. Future previews must treat uploads as untrusted
content and use an explicit resolver rather than fetching descriptor URLs.

Existing saved-revision export verifies its generated output by re-importing it.
A clean PNG portrait with complete CCv3 descriptors passes PNG and CharX round
trips, including attachments and opaque descriptor fields. Raw PNG image metadata
also remains in the stored asset and can survive CharX. PNG card loading strips
text chunks from its portrait, so PNG export of a metadata-bearing portrait fails
with `EXPORT_LOSS` when that would change identity. No silent repair is made.
CCv2 implicit portraits are supported without converting the document to CCv3.
Existing export size limits still apply independently of revision limits.

## Editor behavior

The Assets section supports CCv2 implicit portraits and CCv3 portraits and declared
attachments. Users can upload or replace files, edit names/types, reorder and
remove attachments, preview supported raster portraits and download exact draft
bytes. Portrait replacement updates `ccdefault:` aliases and the first linked
icon together. If needed, CCv3 adds a primary icon descriptor. Removing a portrait
asks for confirmation and removes its linked descriptors; removing a single
attachment leaves any independent portrait intact. Unknown descriptor properties
and unsupported metadata values remain preserved.

Every controller owns its binding plan and immutable Blobs. Switching tabs keeps
that plan; changing text or lorebook fields joins the same explicit save. Ordinary
saves still use the document operation when no asset plan is needed. Descriptor-only
edits use the asset operation. Successful saves adopt the returned revision and
release the plan; failures retain uploads and text for retry. Save locks all draft
mutations. Discard restores the opened/saved baseline and clears pending uploads.
Neither operation changes another open editor or its original workspace target.

The host resolves only authorized saved revision paths. No descriptor URL is
fetched. Inline previews allow PNG, JPEG, WebP, GIF and AVIF media types; other
attachments are downloaded. A preview is not validation of image encoding.
Requests are cancelled when the view changes, late results are ignored, object
URLs are released, and failed list/preview reads can be retried. A delayed old
portrait cannot replace a newly selected draft image. Removal confirmations also
expire when the draft they addressed changes.

## Evidence and remaining work

Five service scenarios run on both native SQLite and emulated IndexedDB: complete
asset lifecycle and exports; ownership, bindings, lineage and no-op behavior;
input ownership, upload failure, cancellation and a concurrent winner; CCv2
portrait export; and explicit SillyTavern PNG transport with loss rejection.
Two real-account HTTP scenarios cover multipart validation,
private reads, unchanged originals, stale heads and revocation after upload but
before commit.

Five controller tests cover independent plans, portrait aliases, opaque metadata,
failed saves and locks, retained binding reindexing, descriptor-only saves, upload
compaction, CCv2 behavior and incompatible input. Three production-build Chromium
workflows cover local, static and hub profiles: add/replace/reorder/remove,
preview/download, joint prompt saves, network retry, two-pane stale saves,
same-account reauthentication, delayed-read cancellation, browser reload, discard,
exact accepted originals and PNG/CharX export/reimport. Desktop and 390px mobile
screenshots were reviewed. This establishes the shared asset editor, not full
legacy media-library parity. Collections, batch tools, image conversion and general
external asset transport remain outstanding. The explicit SillyTavern PNG profile
now passes a portrait/alias round trip against the real application; see [export evidence](card-export.md).
