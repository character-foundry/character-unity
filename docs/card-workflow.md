# Card workflow foundation

`packages/cards` joins the external Foundry SDK to Unity's store and verified
asset service. The Node API mounts these operations with local single-owner
sessions. Architect exposes it through a local library and two independent
editor panes; the hub mounts the same editor with real account sessions. See
[hub accounts](hub-accounts.md) for that profile.

## Local access

The local-profile Node host must bind loopback. `POST /api/local-session` with an allowed Origin
and `X-Unity-Session: local` establishes an HttpOnly, SameSite=Strict session cookie.
The session represents the local operator (`urn:unity:user:local`); it is not a
hosted login system. Allowed browser origins are the API's own origin and the
Architect/hub loopback development origins on ports 9310/9311. Rebinding through
an unrelated Host, cross-site requests and mutation requests without an allowed
Origin are rejected. Session secrets are generated per server start and are not
logged or returned in JSON. Restarting requires a new local session.

The shared API instead accepts an injected authenticator for hosted accounts.
An unconfigured Worker does not grant a local session or expose usable card routes.
Every domain operation verifies workspace ownership. Actor/author identity comes
from the host, never from a JSON owner/author field submitted by the browser.

| Route | Behavior |
|---|---|
| `GET /api/workspaces` | Current actor's workspaces, bounded to 100 |
| `POST /api/workspaces` | Create from `{name}` |
| `GET /api/workspaces/:id/cards` | Bounded card list with `limit`/`afterId` |
| `GET /api/workspaces/:id/card-summaries` | Globally filtered/paged owned cards and Archive references |
| `POST /api/workspaces/:id/imports` | Raw accepted file body; optional `X-File-Name` provenance |
| `GET /api/workspaces/:id/cards/:cardId` | Current revision and immutable source reference |
| `POST /api/workspaces/:id/cards/:cardId/revisions` | Save `{expectedHead, document}` |
| `GET /api/workspaces/:id/cards/:cardId/original` | Exact accepted bytes as an attachment |
| `GET /api/workspaces/:id/cards/:cardId/export` | Verified saved revision; explicit `revisionId` and `format` |

Request bodies are bounded and have a 30-second read deadline. Malformed input,
missing data, unauthorized access and stale heads return errors; no route silently
overwrites the current revision after a head conflict.

## Imports and saves

Foundry parses JSON/PNG/CharX, and Unity keeps `originalShape` rather than a lossy
normalized view. Only wrapped CCv2/CCv3 documents are currently editable. Existing
embedded assets are resolved with Foundry URI primitives and bound to verified
byte digests; an implicit portrait is also included in identity. Remote/missing
assets are reported unavailable and are never implicitly fetched. RisuAI's opaque
module is preserved alongside its card and participates separately in deduplication;
it is not an editable card-content binding. Unmapped assets, unwrapped/legacy cards
and Voxta need additional loss-preserving adapters and are rejected rather than
silently discarded.

Standalone file import first checks the exact accepted-byte digest, before parsing
or resolving external assets. A miss is parsed through Foundry and checked by
content identity with asset digests, plus opaque module and lineage distinctions.
Unity and the connected Archive are both checked. An existing match returns
`{card:{id}, import:{created:false, match}}`; clients open that returned ID rather
than requiring a newly created revision in every response. Concurrent claims share
the same entry/upload key. Different source records retain their own provenance,
and a shared ancestor root is not a deduplication key for edited forks.

The legacy Archive has no hash index. An incomplete identity miss refuses the
import without writing another card; its bounded, explicit metadata-index command
is an operational writer action, not something browsing or importing silently
launches. See [identity indexing and its authorization gate](archive-existing-storage.md#reference-identity-index).

The accepted file is stored as an immutable completed asset. Schema v2 atomically
attaches its source/provenance reference when creating the card and initial
revision. An import does not invent lineage. A source may already contain verified
lineage; its accepted file hash can differ from that lineage's earlier root hash.
Original download always means the file this workspace accepted, not an implied
permission to download a remote ancestor.

Native Archive favorites/imports are different: they store exact-version membership
and a bounded summary, not accepted original bytes or asset bundles. Unfavoriting
keeps membership; explicit Remove unlinks it. Reads resolve the pin through Archive,
and unavailable originals remain unavailable rather than falling back to a newer
version. An unchanged Save creates nothing. A changed Save atomically creates one
owned fork with exact Archive ancestry; inherited files remain external locators,
and only new uploads enter Unity's blob store. Format/opaque-field changes still
count as edits even when portable content identity is equal. Reference originals,
revision exports and Send-to-chat use the same verified read-through path.

Saves preserve opaque fields and existing assets, compute identity through Foundry,
and add explicit revision lineage. Saving the same preserved JSON document
returns the existing revision; meaningful document edits get a new revision even
if canonical portable content is equivalent. Submitted lineage cannot be replaced
or stripped. The asset descriptor list cannot be relabeled by a prompt save;
asset editing uses the explicit [asset revision operation](asset-revisions.md).
Stale expected heads return 409 and leave
no partial revision. Opening/reopening never changes the source or invents lineage.

SQL and blob storage do not share a transaction. Validation precedes uploads and
SQL source/card/revision records commit together, but a later failure can leave
unreferenced immutable bytes. Existing staging/retry rules apply; operational
garbage collection remains outstanding. Source references are included in the
retention model and must not be mistaken for unreferenced assets.

## Validation and remaining work

The same service tests run on native SQLite/filesystem and emulated IndexedDB storage with the pinned SDK, including
actual PNG/CharX containers. The common store contract runs source rollback,
immutability, ownership and populated-v1 upgrade cases on SQLite and local D1.
HTTP tests exercise local-session origin checks and import/edit/reopen/download;
the executable smoke check repeats that workflow through a built Node server.
Playwright exercises the built Architect UI against that API with a temporary
on-disk database: independent drafts, field edits, save conflicts, lost-session
reconnection, failed-save recovery, reload and exact original download.

The browser-only build composes this service directly over IndexedDB, including
original and asset bytes. Real Chromium tests cover JSON/PNG/CharX imports,
offline saves after page load, cross-tab conflicts, quota failures and original
downloads without API calls.

Both profiles also import reviewed Archive subsets through the same service.
See [selection import](archive-import.md) for preflight, asset bindings and partial
failure semantics.

All hosts can read private revision history and compare any saved document with
the current draft. Bounded pagination stays stable across concurrent saves, and
viewing history never changes the draft or its save target. See
[revision history](revision-history.md) for access, pagination and conflict behavior.

Saved revisions can be exported from all three editor hosts. The service verifies
identity and lineage by reparsing generated files; unsupported loss is rejected.
See [exports](card-export.md) for format limits and the passing actual SillyTavern
JSON and supported PNG portrait/alias flows, including rejection of changed external
content and image re-encoding. CharX exports preserve opaque descriptors and colliding names. Rich editor
tools, media collections and general external asset transport remain required work.
