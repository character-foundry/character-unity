# Editor port status

## Active unified editor — 2026-10-13

`apps/web` mounts `packages/architect`, not the earlier `packages/editor`
scaffold described below. Useful Architect components now use native Unity
import/revision/asset contracts without an inherited old-server API client.
Wrapped JSON, PNG and CharX imports send original bytes to Foundry on the backend;
no browser reconstruction or duplicate IndexedDB card/asset store is used.

Portraits and declared attachments are staged with the editor draft. Explicit
Save commits text and asset bindings together. New/Fork creates one initial
revision only on Save; unchanged inherited files reuse stored asset references.
Failed/stale saves retain the draft. Recovery text drafts are browser-local, not
automatic immutable server revisions; staged files remain in memory and are not
crash-recovered. Discard releases staged object URLs. Historical Restore creates
a new revision containing the historical text **and** asset references.

Browser-local LLM providers, templates, presets, wizard prompts, themes and editor
preferences remain. Nonexistent Architect-server RAG/ComfyUI/backup/name-tool
paths and old dashboard/import/parser shells are retired, not replaced with
fake endpoints. Native optional tools are tracked in `cu-1o2.5.13`.

Each editor has an explicit `EditorSession`: immutable workspace/API client,
per-instance vanilla card/UI/token/LLM stores, staged assets, revision heads,
portal root, wizard transcript and cancellable selection/lifetime. React hooks
require that session's provider; there is no default/current-session fallback.
Closing or selecting in one editor cannot retarget another editor's pending work.
Auxiliary reads never advance its expected Save head. Concurrent same-card edits
retain independent drafts and use the server's existing expected-head conflict.
The application retains the same session through New/Fork's first Save and route
promotion, preserving edits/assets entered during the pending Save.

Recovery keys include workspace, card and draft owner; deleting or saving one
owner does not erase another's snapshot. Restore copies the offered snapshot into
the restoring owner before acknowledging it; Discard acknowledges only the exact
offered snapshot, and later changes from its original owner remain recoverable.
The original expected head stays pinned so restoring stale text cannot overwrite
a newer revision. This is text recovery, not durable recovery of staged files or
unsaved New/Fork drafts. Browser-local preference contents are intentionally shared.

The viewer and shell use native React Router/HTML without Next shims (`cu-1o2.26`).
Archive references open in this same editor without creating owned documents or
asset rows. An unchanged Save retains the reference; a changed Save creates one
owned fork pinned to its exact Archive source, retaining inherited asset locators
and storing only newly uploaded bytes. Route promotion keeps the current editor
session and pending edits. Native imports report existing file/content matches
instead of storing another card. References retain exact-original downloads,
revision exports and Send-to-chat; a missing source remains explicitly unavailable.

Native viewer/Next-shim removal (`cu-1o2.26`) and editor isolation (`cu-1o2.5.12`)
are complete. Wizard workflow QA (`cu-1o2.5.5`) remains low priority.

`pnpm dev` starts API + unified web. `pnpm test:e2e:unity` builds the real unified
web UI and a separate two-host browser fixture beneath the test build's existing
`/assets/` route, then runs isolated production-Node browser workflows. The fixture
is not part of the ordinary production build and adds no application/API route.
The legacy
host tests below remain useful scaffold regressions but do not prove parity of
the active editor.

## Earlier scaffold implementation (historical)

Architect has local Node API and browser-only IndexedDB profiles; hub mounts the
same editor with authenticated account sessions. This is a staged port
of the legacy editor, not feature parity. Source inspection used Architect commit
`ceb138e769470f104851f34869c1fb058c50d11b`. Its global card/UI/settings stores and
application registry are not dependencies of the new package.

| Capability | Current state | Next boundary |
|---|---|---|
| Core field metadata | Extracted from legacy `features/editor/config/field-definitions.ts`; labels, field paths and capability flags retained | Review optional fields against future format adapters |
| Draft state | Per-instance controller, copied/frozen snapshots, explicit save/discard, independent listeners | Additional host ports must remain per instance |
| CCv2/CCv3 forms | Basic, character, greetings and advanced fields, string arrays/tags, multilingual notes, depth prompt | Rich text conveniences and preferences |
| Opaque data | Unknown envelope/data/extension/lorebook/asset properties remain untouched; incompatible field shapes are preserved | Conformance across remaining adapters |
| Save/reopen | Local API or IndexedDB, shared Foundry identity/lineage, immutable revisions and sources | Other host profiles |
| Library/import | Workspace selection/creation, paginated local cards, wrapped JSON/PNG/CharX, copied-index lexical/Boolean Archive search and reviewed subset import, exact original download | Advanced/vector Archive search, live adoption and other formats |
| Concurrent drafts | Two panes, expected-head conflict, failed-save retention, saved-versus-draft comparison and explicit discard | Conflict merge/field restoration |
| Session recovery | Local reconnect and hub same-account reauthentication retain drafts; cross-tab account mismatch locks the hub | Durable crash recovery |
| Asset editor/portrait | Per-instance uploads, portrait aliases/previews, attachment name/type editing, ordering/removal, exact downloads and joint explicit saves in all three hosts | Media collections, batch tools and explicit image conversion |
| Lorebook editor | Shared CCv2/CCv3 book settings, searchable entries, keys/content/flags/extension fields, copy/delete/list ordering; reviewed native standalone JSON import and draft download preserve opaque fields and duplicate/missing IDs | Standalone library, cross-format conversion, AI assistance and format-specific numeric enum editing |
| Preview, diff and snapshots | Injected read-only history and paginated full-document comparison in all hosts; late reads and session recovery preserve drafts | Rich preview, named snapshots, restoration/merge UI |
| Templates, focus fields, tag autocomplete | Metadata preserved; interactions not ported | Host-independent services and UI |
| Token counts | Shared Tokens view in all hosts; injected browser worker, strict SDK encoding, field/greeting/lorebook coverage and per-instance cancellation | Selectable encodings, inline field counts and chat-specific prompt totals |
| AI assistance | Flags retained; actions not ported | Injected AI providers with per-instance cancellation |
| ComfyUI, Voxta, Risu modules, SillyTavern integration | Explicit SillyTavern JSON and a supported PNG portrait/alias transport pass against the real application; remaining integrations are unported | General external asset transport, explicit image conversion, derivative import and other integration adapters |
| Export/publish/fork | All editor hosts download verified saved JSON/PNG/CharX revisions with explicit loss rejection; hub reviews/publishes and forks | Asset-bearing external interoperability and richer format adapters; CharX descriptor preservation and visible published lineage are implemented |
| Static/browser profile | Separate static build, IndexedDB store/blobs, same services; edit/import/save offline after loading | Offline page caching, full-library backup and storage lifecycle |

The host constructs and retains controllers. Switching workspaces never rewrites
an open controller's save target. Closing a dirty pane asks for discard; page
navigation gets the browser's unsaved-changes prompt. A lost session can be renewed
while drafts stay open. Reload restores saved cards through workspace selection,
not unsaved in-memory drafts. There is no autosave or crash recovery yet.

The metadata extraction does not move Foundry code into Unity. Format parsing,
identity, hashes and lineage remain in the pinned external SDK and are invoked by
the card service. Browser forms never construct lineage themselves.

The embedded lorebook port uses the committed legacy `LorebookEditor.tsx` at the
same baseline. Its application globals, API/IndexedDB discovery and AI sidebar
are not imported. Entry actions address positions in the instance's draft because
imported IDs may repeat or be missing; existing IDs are never rewritten. Copying
deep-copies entry metadata and assigns a new unused numeric ID. List movement
preserves each entry's insertion-order value. Book/entry fields change only after
explicit input; opening the view does not normalize, insert defaults or save.
Unsupported shapes and unknown numeric enum representations remain read-only and
are preserved. Nullable supported fields retain null until explicitly edited.

Six lorebook controller tests and three Chromium workflows cover native Node,
browser storage and the hub, including two simultaneous editor instances, failed
saves, negative/zero values, duplicate IDs, opaque extension siblings, copy/delete/
ordering, explicit discard, export/reopen and unchanged accepted originals. The
mobile hub and desktop two-editor screenshots were reviewed. These checks prove
embedded-card editing, not standalone lorebook format/library parity.

The [standalone lorebook file workflow](lorebook-files.md) adds explicit reviewed
native JSON replacement and draft downloads in all three hosts. Five transfer/
controller cases and three Chromium workflows verify preservation, stale review
rejection, delayed reads, failed saves and unchanged accepted card originals.
It consumes Foundry's original parsed shape because its current normalization
loses some fields. Cross-format conversion and standalone library parity remain
staged; standalone file bytes are not stored as source attachments.

The shared [revision history](revision-history.md) view uses the existing immutable
store via a host read port. It compares any saved revision with the current draft
without retargeting saves. The legacy global diff/snapshot stores are not imported.
Node, browser and hub workflows cover pagination, concurrent saves, cancelled reads
and failed-session recovery. Named snapshots and automatic merging remain staged.

The shared [asset editor](asset-revisions.md) stages immutable upload Blobs and
revision-scoped bindings in each controller. Five controller tests and three
Chromium workflows cover failures, stale saves, session recovery, cancellation,
reload, exact bytes, export/reimport and discard. It never fetches asset descriptor
URLs or rewrites accepted originals. Preview support is limited to raster images;
other attachments remain downloadable.

The [text token counter](text-token-counts.md) replaces the legacy global token
store with an optional host port and read-only per-instance analysis. It uses
Foundry's public encoder in an on-demand browser worker, preserves unsupported
data and reports failures without approximate fallback. Five unit cases and
three Chromium workflows cover the port; the local Worker rehearsal checks its
static asset delivery. The displayed total is selected text, not chat context.
