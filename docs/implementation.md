# Implementation status and acceptance gates

## Remaining non-migration implementation, completed 2026-10-14

Implemented since the native sharing checkpoint below:

- Native Statistics with workspace-owned counts, explicit Archive coverage and
  read-only SQL/IndexedDB snapshots; no scrape/index/model work on open.
- Standalone lorebook/preset/persona originals, immutable revisions, reviewed
  native sharing, recipient private forks and precision-safe raw JSON editing in
  the same Unity store. See [scope and limits](standalone-content.md).
- Reviewed inbound chat-text edits with three-way conflict checks, private forks,
  commit-time review pins and trusted atomic receipts. Original assets/opaque
  fields remain intact; raw remote response bytes are not retained. See
  [chat edit contract](chat-app-edits.md).
- Deleted-card retention-aware maintenance, explicit filesystem orphan review,
  browser cleanup with late-writer fences, and Node backup/verify/new-directory
  restore. No maintenance is run against live data by implementing these tools.
- Native account and browser-only Worker profiles; scoped domain services,
  static/API routing and bounded Archive objects. No remote deployment.
- Native lorebooks, searchable paged import, strict Tokens and actual read-only
  unified/side-by-side history. Core forms, Focused, Preview, wizard and tools
  preserve incompatible field shapes instead of coercing them.
- Native local retrieval/provider/ComfyUI tools and deterministic wizard QA;
  provider quality and a live ComfyUI workflow remain operator acceptance.
- Whole-publication opaque-Risu exclusion before signed pagination, explicit
  direct-read diagnostics and unchanged original/module bytes. HEAD and already-
  disconnected responses release abandoned streams before the Node adapter
  drops them. Forced-GC real-HTTP tests cover both pre-return and active-read
  disconnects rather than relying on garbage collection to close descriptors.
- Retired scaffold hosts/form/UI packages. All three profiles use native web;
  browser IndexedDB identity and additive upgrades remain in place. See
  [coverage and legacy repository notices](native-retirement.md).

Final `pnpm check` passes: 1,016 tests across 122 files, every conformance report,
lint, all profile/E2E types, workspace and both Worker builds, SDK ESM/CJS/workerd
probes, Node smoke, Archive install/reopen and native Worker/browser-light
rehearsals. All 86 browser workflows pass: 63 native local, 12 account/TLS, 10
static browser and one explicit cross-origin browser–Archive rehearsal. Native
Archive SQL/originals/versions/Lance invariants pass after teardown. No FileHandle
GC warnings remain in the final run. Desktop/mobile captures were inspected.

Independent Standards and Spec rereviews are clear after fixes for receipt
upgrades, opaque-field mutation, numeric rounding, bounded source selection,
comparison layout, inherited browser assets and response-stream ownership.
Combined-suite fixture scopes and status locators now reflect real asynchronous
UI state; domain assertions were retained. Evidence is in ignored
`runtime/non-migration-final-check.log`, the conformance reports and the four
native browser report directories. Older totals below describe historical
checkpoints, not this expanded tree.

Live Archive/provider/writer takeover and migration remain excluded. Foundry pin
`7699064` is still held locally; only its Risu-sized identity-limit commit is
unpublished, while earlier identity/lineage/sync work is on the remote feature
branch. Fresh Docker bootstrap remains gated by that exact SHA. Public deployment,
full-library browser backup/eviction recovery and reconciliation of pre-existing
legacy Architect worktree changes are not claimed. An unchanged Archive reference
still cannot publish directly; save a changed owned fork first.

## Native library, sharing and account UI, 2026-10-13

The active `apps/web` shell now includes the native library/viewer presentation,
card action menus, account/workspace controls, Sharing and Connected hubs. The
library and Archive use the same tile conventions and display preferences. These
pages use native React Router and Unity services; no Next shim, CardsHub endpoint
fallback or mutable global current API client is required.

Sharing reviews 1–20 exact owned saved revisions, with a paginated historical
revision picker. Refreshing the library or saving a newer head cannot silently
change the selection. Review precedes publication. Publication detail supports
version-checked visibility/fork/original policies, permitted original downloads,
private forks and visible published lineage. Inaccessible parents stay opaque;
private library history is not loaded to enrich lineage. Archive references are
read-only links and cannot be published without a changed owned fork. An unchanged
Save deliberately creates no owned copy.

Configured remote controls are in the same shell: browse, pull a verified private
fork into the native editor, choose an exact saved revision, prepare/review a
durable return, then explicitly send or retry it. The browser supplies connection
IDs, never destination URLs or signing credentials. Preparation notices are
actor/workspace-scoped; the server outbox remains authoritative. Receiving a
return creates a private draft, not an automatic publication.

`GET /api/client` declares local/account profile and browser capabilities. The
session runtime and library clients capture an immutable actor/workspace owner
for JSON and binary requests, including stored media and downloads. Expiry or an
account change locks existing work for same-account recovery; deliberate account
switching disposes captured clients and editor sessions. Hub editors neither load
browser LLM credentials nor issue direct provider calls. Local installs retain
browser-local providers, templates, presets and preferences.

`packages/tokenizer` now owns the shared browser token-worker boundary. The active
app no longer imports the scaffold editor to count text. Earlier `apps/architect`,
`apps/hub` and `packages/editor` remain as regression hosts pending retirement;
the browser-only IndexedDB profile and its data-preserving upgrades remain.

Verification: all 838 tests across 99 files and every conformance report pass.
Full package/E2E type-check, lint, workspace builds, built Node smoke, public SDK
identity/sync probes, Worker rehearsal and Archive SQLite/Lance install/reopen
checks pass. All 45 native local browser workflows, 12 real account/TLS workflows
and 45 retained scaffold/browser regressions pass. Desktop/mobile screenshots and
independent Standards/Spec reviews cover real controls, downloads, exact revision
review, durable return retries, account changes, modal recovery and cancellation.
The account suite is included sequentially in `pnpm check`.

Authenticated reads bypass browser caches; protected media owns revocable URLs
and retries on recovery, including active-to-active local renewal. Offscreen
portraits and audio/video previews do not acquire bytes before visibility or an
explicit request. Authored HTML/Markdown resolves only exact stored/staged image
bindings; unresolved images and CSS resource loads remain inert while original
documents/bytes stay unchanged. Old local recovery snapshots and acknowledgments
remain readable only by the explicit local profile. Saved searches are scoped to
stable actors/workspaces, with a safe local-only upgrade from old preferences.

Native Node distribution staging passes with exact UI/tokenizer assets and no
browser Node/native-driver leakage. A fresh Docker build/rehearsal has not run:
it remains gated on publishing the held Foundry pin. Worker verification uses its
explicit retained scaffold assets, not a claim of native Worker UI hosting.
Opaque Risu resources remain an explicit remote-protocol limitation in
`cu-1o2.13.1`; no data is stripped to claim success. A non-failing FileHandle GC
warning from the account asset rehearsal is recorded for diagnosis in
`cu-1o2.9.11`. No public deployment, live corpus indexing, provider activation,
Archive writer takeover or Foundry push occurred. Those gates remain held.

## Archive references and native shared search, 2026-10-13

`cu-1o2.27` and `cu-1o2.9.1` are implemented together. Favorites/adds create
exact-version library membership, not owned original copies. Unfavoriting keeps
the link; Remove only unlinks it. Viewer/editor/export/chat resolve pinned content
through Archive. An unchanged Save creates nothing; a changed Save creates one
owned fork with immutable external ancestry and inherited asset locators. Only
new uploads enter Unity blobs. Representation/opaque-field changes are edits even
when Foundry portable content identity remains equal.

Standalone imports check exact bytes before parsing, then Foundry content/asset
identity plus opaque module and lineage distinctions. Atomic claims/shared upload
keys deduplicate concurrent imports. Different upstream records retain provenance;
old/new version pins remain distinct. An incomplete Archive identity miss refuses
the import without storing a duplicate. Legacy metadata indexing is an explicit,
bounded, resumable writer command in the same database—not work triggered by
connecting, browsing or importing. It has not been run against the live corpus.

The native Archive shell exposes lexical/Boolean/semantic/hybrid/typed-filter modes,
supported ordering, provider/model/coverage disclosure, explicit failures and
snapshot-bound paging. No embedding occurs while drafting a query and no requested
mode silently falls back. Quick View and library actions share the selected exact
version. Mixed library filters/tags/order include references, including live chat
placements. Browser-only chat remains unsupported rather than fabricated.

Saved Unity edits/new cards have a durable outbox, with bounded event-driven delivery
to an explicitly enabled Archive-owned projection table in the existing LanceDB.
Missing/failed providers remain retryable; deletes have persistent sequence fences.
Reads/favorites enqueue nothing, startup is bounded, and idle delivery does not poll.
Native search scopes owned hits through the authenticated host, hides deleted hits
while delivery is pending, and preserves raw paging/excerpt alignment. Status and
Refresh/Retry are visible in the Archive page. JSON-sidecar reads fetch only the
requested verified object; canceled requests cancel upstream work.

Unity schema 13 and IndexedDB schema 3 preserve existing data. The in-place Archive
index additions are opt-in; no live migration, identity indexing, library search
writer activation, corpus copy or service restart has occurred. Actual provider
connection/model-quality checks and coordinated takeover stay open in `cu-1o2.9.7`.
Foundry publishing remains held in `cu-1o2.25`. See
[configuration and operational gates](archive-existing-storage.md).

Verification: all 747 tests across 87 files and every conformance report pass,
including native SQLite, D1/workerd and IndexedDB. Full package/E2E type-check,
lint, workspace builds, built Node smoke and the SQLite/Lance install/reopen
rehearsal pass. All 38 production unified browser workflows pass, alongside all
45 earlier scaffold/account/browser regressions. Independent Standards/Spec
reviews found and closed version, retry, deletion and revocation gaps; regression
tests and inspected desktop/mobile screenshots cover the fixes. These are
synthetic/local checks, not live provider/corpus acceptance.

## Editor lifecycle checkpoint, 2026-10-13

`cu-1o2.5.12` is implemented after the native viewer: each explicit editor session
owns its immutable workspace/API, draft/UI/token/provider stores, revision heads,
assets, recovery owner, portal root, wizard conversation and cancellable requests.
No singleton/current-session fallback remains. First Save keeps the same session
across route promotion; auxiliary reads do not repin its Save head. Module
registration is concurrency-safe; tokenizer tables load on demand. Unreachable
collection/sidebar and old deployment-mode paths are removed.

Recovery snapshots are workspace/card/owner scoped. Exact UUID acknowledgments
survive reopening without deleting another live editor's row, even for two edits
in the same millisecond. Restore first creates an owned recovery copy and retains
the source expected head; stale text still encounters the normal Save conflict.
Staged files and unsaved New/Fork drafts remain memory-only, not crash-recovered.

627 tests across 79 files, every conformance report, expanded lint, full package
and E2E type-check, builds and built Node smoke pass. Twenty-four production
Node/browser workflows pass (nine editor, eight viewer, seven isolation), plus
the rebuilt frozen-clock recovery regression after the UUID change. Coverage
includes colliding IDs across workspaces, reversed loads/saves, focused Ctrl+S,
independent assets/dialogs, same-card conflicts, late AI/disposal, pending fork
cancellation, failed-route Save gating and recovery ownership. Late tokens/model
changes are tested at the injected store seam. Screenshots and independent
Standards/Spec review pass. All 45 earlier scaffold/account/browser workflows
also pass; those are regressions, not a claim of unified publication UI parity.

Native viewer and editor isolation beads are closed. Wizard QA stays low priority.
Archive reference/deduplication was separate work at this checkpoint and is now
implemented above. Optional native tools and scaffold retirement remain open.
Live Archive takeover and Foundry publishing stay on hold.

## Native viewer checkpoint, 2026-10-13

`cu-1o2.26` is implemented: native React Router shell and viewer, no Next/sharp
shims or inert client directives. Profile and quick view use native favorites,
forks, editing, chat placement and downloads; no fabricated social counters or
nonexistent CardsHub endpoints remain. Stored assets are bound to the displayed
revision, accepted originals retain their actual format metadata, and authored
remote image URLs do not auto-fetch. Native dialogs, accessible uncapped content
collapse, mobile navigation and bounded section tabs replace lifted behaviors.

585 tests across 73 files, all conformance reports, lint, full type-check and
production web build pass. Seventeen production Node/browser workflows pass
(nine editor, eight viewer), including original/container/attachment bytes,
read/export/favorite failures, canceled routes and 401 recovery, URL navigation,
mobile fit and long content beyond the former 5000px clipping cap. Independent
review findings were fixed. Live Archive and Foundry publishing remain untouched.

At this checkpoint editor isolation (`cu-1o2.5.12`) was next; it is now completed
above. Wizard QA stays low priority.

## Earlier native editor integration checkpoint (`14609c6`), 2026-10-13

Owner authorized editor/import cleanup while live Archive takeover remains on
hold. The active `apps/web` editor is `packages/architect`; sections below about
the per-instance `packages/editor` describe the earlier scaffold, not this host.
See [current editor capabilities and explicit remaining gaps](editor-port.md).
Native file imports, staged portrait/attachment edits, atomic first Save/forks,
assets-aware immutable Restore and supported browser-local AI/settings replace
old-server fallbacks. Viewer/Next-shim removal follows the editor phase.

Owner priority at that checkpoint: native viewer/Next-shim removal (`cu-1o2.26`) next,
then editor isolation (`cu-1o2.5.12`). Wizard QA (`cu-1o2.5.5`) is low
priority and does not gate either pass.

Verification: type-check, expanded native-editor lint, all 571 tests across 69
files, every conformance report (including 38/38 SQLite/D1 store checks), builds,
and nine production-bundle Chromium workflows pass. Browser checks cover
original JSON/PNG/CharX imports and opaque data, exact attachments/exports,
New/Fork first Save, failures/conflicts/discard, edits during first Save, initial
read failures, restored historical portraits and mobile interaction. Built Node
smoke also checks client deep links without serving HTML for missing API paths.
Independent standards/spec review findings were fixed and regression-tested.
All 45 earlier scaffold/browser/account workflows also pass, for 54 passing
Chromium workflows across the old profiles and active unified application.

Closed editor beads: `cu-1o2.5.8`, `.5.9`, `.5.10`, `.5.11`. Wizard workflow QA
(`.5.5`), instance isolation (`.5.12`), native optional tools (`.5.13`), scaffold
retirement (`.5.6`, `.15`), viewer/shims (`.26`) and reference/deduplication (`.27`)
were explicit work at that checkpoint; `.26` and `.5.12` are now complete above.
The one external-image Risu card is deferred (`.9.10`);
Foundry publishing remains on hold (`.25`). No live Archive processes or data
were changed during editor integration.

## Archive-first correction, 2026-10-13

The [owner direction](../../1013_archive_foundation.md) and
[accepted storage decision](adr/0001-existing-archive-and-library-references.md)
supersede the separate native-store rollout. Existing Archive schema/file storage
and LanceDB stay authoritative; new scrapes must write into that same database.
Live takeover and real-source acceptance remain on hold; editor cleanup is now authorized separately.

At the start of this correction, existing-storage reads/writes and LanceDB reuse
were not implemented. The native prototype uses a different schema and database.
General file imports do not deduplicate cards; Archive imports only perform a
sequential source-ID lookup before copying. Favorites require owned Unity cards;
reference-only membership, cross-store import deduplication and a first saved
fork directly from an Archive reference remain later Unity work. Fork drafts
already wait for Save for owned library parents.

Implemented now: an explicit existing-storage backend, additive bookkeeping in
the same `cards.db`, accepted-file reuse, retained versions, source/alias
deduplication and blacklist carryover. Existing lexical/vector tables and active
generations are reused. Bounded queue drains preserve failed/newer work and reuse
unchanged embeddings. Scheduling wakes for due work and has no disabled-source
polling. Response downloads enforce byte limits during streaming; Chub keys stay
on gateway requests. Type checks, lint and all 507 tests pass, including native
SQLite/D1 conformance; the Archive build passes. A preexisting chat conformance
suite-name mismatch was corrected so its six passing cases are recognized.

Read-only verification against the real 147,265-card corpus passed all four
providers, exact original digests, lexical and anchored Boolean search. No new
database tables or corpus copy were created. Ten idle seconds used zero CPU
ticks after the reads. See [runtime/configuration and evidence limits](archive-existing-storage.md).

Operational acceptance must demonstrate source/alias deduplication, same-database
scrapes, original/version retention, queue/index compatibility, recovery, bounded
work and measured quiet idle behavior. Synthetic tests do not close real-corpus
or live-writer takeover gates. No live database cutover has occurred.

## Foundation scope

The local repository foundation is implemented: external Foundry primitives,
Archive-owned SQLite/Lance search behind a read contract, shared Unity domain
services/store, per-instance editor and standalone/hub hosts. Reproducible
bootstrap/check commands exercise Node, static browser and local Worker profiles.
The initial Archive fixture → edit → selected publication → second-user fork →
actual SillyTavern round trip has passed for the documented JSON and supported PNG
transport profiles. This establishes the foundation, not complete legacy feature
parity or a completed Archive migration.

The remaining rows below track subsequent feature migration and operational
acceptance. In particular, real-corpus/model quality, live adoption and rollback,
remote deployment, richer editor tools and a released Foundry contract remain
open. The repository is local; publication and production cutover have not occurred.

The latest foundation check after native lorebook file transfer passed
`pnpm bootstrap` and `pnpm check`: 358 tests across 43 files, 45 Chromium workflows,
SDK identity/sync checks, lint/types, builds, SQLite/D1 conformance, native Archive
generation/reopen, HTTP smoke and local Worker rehearsals. The browser rehearsal
also verified the copied Archive inventory remained unchanged. Logs are in
`runtime/lorebook-files-bootstrap.log` and
`runtime/lorebook-files-foundation-check.log` (local, ignored artifacts).

## Scaffold delivered

- Independent local git repository, pnpm workspace and lockfile.
- Node 24 / TypeScript / ESM and strict type checks.
- Vite/React Architect and hub hosts mounting the same editor; shared presentation package.
- One Hono implementation with Node and Workers entrypoints.
- Independent Archive Node host with opt-in fixture and copied-SQLite read sources; no jobs.
- Lint, boundary route tests, production builds and executable HTTP smoke checks.
- GitHub Actions workflow running the same checks (remote execution pending repository publication).
- Local-only Worker dry-run build; no remote resources or deployment.

A health response means only that the scaffold process is serving. It does not
claim database readiness, functioning search, accounts or an operational editor.

## Shared store foundation

Implemented: versioned/checksummed migrations, workspace-scoped repositories,
immutable revisions, atomic head advancement, parent/fork provenance, bounded
pagination, and staged/completed asset metadata. Native SQLite and local D1 run
16 shared requirements each; SQLite also has on-disk reopen/two-connection checks.
`runtime/store-conformance.md` is regenerated by every full test run.

The Node API uses its own `apps/api/runtime/unity.db` (or `UNITY_DB_PATH`) and
exposes schema readiness at `/api/ready`. The Worker account profile now composes local D1/R2 with the shared services;
operator setup and the built hub are tested locally, not deployed. Schema v2 adds immutable accepted-source
references, with v1 data-preserving upgrade and rollback tests. The card service now
computes identity and save lineage through Foundry; the store remains a trusted
repository that accepts already-computed identity from the application layer.

## Immutable bytes and assets

Implemented: streaming filesystem/R2 byte adapters with exact SHA-256/length
verification, configurable limits, temporary staging, immutable publication,
retry verification and cancellation. Eight requirements run on each adapter;
R2 tests execute the actual adapter in local workerd with R2 bindings.
The asset service joins verified bytes to workspace-scoped staged metadata and
supports retries after database completion failure. The Node composition root
initializes it with Unity-owned storage. Publication-scoped asset downloads are
now mounted. Card-scoped asset revision, listing and download routes are also
implemented and connected to all editor hosts through per-instance asset ports.

Temporary storage is cleaned on normal success/failure. Schema 9 adds permanent
retirement fences and creation timestamps; the explicit `pnpm assets` operator
commands preview exact unused IDs, retire them atomically and sweep their final
objects with retries. Historical attachments, original sources and all outbox
frames remain protected. SQLite/D1 migration and reference-race cases, Node/R2
deletion failures and delayed uploads, and persisted CLI workflows are tested.
Hard-crash temporary leftovers, objects without SQL rows, browser reclamation
and remote R2 lifecycle work remain open. See `asset-maintenance.md`.

## Per-instance editor and local host

`packages/editor` now owns a separate immutable draft/controller per mount. It
uses the legacy Architect field metadata with new portable path editing and React
forms. Core CCv2/CCv3 scalar, array, tag and multilingual-note fields are editable;
unknown envelopes, extensions and asset descriptors remain in the
preserved document. Incompatible form values remain untouched. Hosts inject saves
and own identity, auth, routing and persistence. Nothing is saved on opening.

The same editor now includes embedded CCv2/CCv3 lorebook settings, entry search,
keys/content/flags and supported extension fields, copying, deletion and list
ordering. Imported duplicate/missing IDs and opaque metadata remain intact;
operations select an array position, and copies own their nested metadata. Six
controller cases and three built-server Chromium workflows cover local, static
and hub save/export/reload/discard, unchanged originals, simultaneous drafts and
failed saves. Reviewed native standalone lorebook JSON import and draft download
now share those three hosts. Five additional controller/transfer cases and three
Chromium workflows cover exact parsed-shape preservation, stale/foreign reviews,
late file reads, explicit replacement, failed saves and unchanged accepted card
originals. Cross-format conversion, a standalone library and AI integration remain
staged. See [standalone lorebook files](lorebook-files.md).

Architect connects to the local API, creates/selects workspaces, imports cards,
opens two independent drafts, saves explicitly, handles conflicts and failed
sessions without dropping drafts, reopens stored revisions and downloads exact
accepted originals. The Node host can optionally serve the built app from
`UNITY_WEB_DIR` on the same origin. The separate browser build injects the same
card/asset services over IndexedDB; it has no API dependency.

Eighteen editor/controller tests and sixteen Architect Chromium workflows cover the two profiles, including
all core field types, desktop/mobile layouts, opaque data, concurrent stale saves,
network failures, expired sessions, reload and unchanged original bytes. `pnpm check`
now builds both profiles and runs their browser tests. See `editor-port.md` for capability status
and `editor-qa.md` for the validation inventory.

## Browser persistence

`packages/browser-storage` implements the store domain contract and verified blob
adapter in a namespaced IndexedDB database. Card/source/revision creation, forks
and expected-head updates use native atomic transactions. IDB requests resume
inside success events; no hashing, stream reads or arbitrary asynchronous work
runs inside a database transaction. Blob publication follows bounded verification
and never overwrites an existing key. Schema v1 is independent of SQL migrations;
unrecognized or newer browser databases are never reset.

Six adapter tests cover rollback, quota failure, scoped data, input ownership,
separate connections, history/forks/pagination, reopen, blob retries/cancellation
and foreign schemas. All seventeen Foundry card-service cases run on native and emulated
IndexedDB storage. Real Chromium tests prove static-only JSON/PNG/CharX workflows,
original downloads, offline editing after load, cross-tab conflicts, profile
isolation and quota-error recovery. Browser data eviction, full-library backup and
service-worker page caching remain operational/product work; see `browser-storage.md`.

## Archive selection import

Both Architect profiles and the hub now share `packages/archive-browser` to
search/filter Archive, select exact IDs, review a
snapshot manifest and import copies into the selected workspace. Node resolves an
operator-configured origin; the static browser build uses an explicit configured
origin with narrowly allowed read CORS. Neither accepts a source URL in an import
request. Workspace authorization precedes reads.

The importer verifies every selected original and available asset, checks portable
bindings and preflights all cards before creating records. Separately stored assets
use explicit portrait/URI bindings and verified bytes, never an external URL fetch.
Imports preserve source tuples and unavailable-asset IDs. Per-card writes remain
atomic; later storage failure reports completed cards and stops the batch. There
is no automatic retry/deduplication or all-or-nothing batch claim.

Seven integration tests cover selected membership, asset fidelity, unchanged sources,
auth, stale snapshots, corrupt bytes, limits, cancellation, partial failure and CORS.
Two real browser workflows cover Archive → editor → save/reopen → exact-original
download on API and IndexedDB profiles. Two additional hub workflows cover an
Archive selection through publication and a second-account fork, preserving an
existing draft during another import, and expired-session selection recovery. Live Archive adapters remain unimplemented;
fixture integration is not production adoption. See `archive-import.md`.

## Hub publication backend

The shared Node API mounts publication, policy, download and fork routes under
either the local session or the explicit hub account profile. Selection pins 1–20 explicit revisions atomically;
Foundry sanitizes documents without adding lineage on publication. Forks copy
verified assets, accept the public JSON snapshot as source, retain root/parent
lineage and commit only after SQL rechecks current permissions. Ancestor visibility
also limits descendant reads, assets and forks.

SQL migration 3 adds immutable publication/fork relations and versioned policies.
Five requirements run on both SQLite and local D1; eight SDK/filesystem service tests
and three HTTP tests prove the two-actor behavior, corruption/permission failures,
unchanged originals and session boundaries. Real account login and the hub UI are
now implemented as described below. See `hub-publication.md` for policy defaults,
source-download semantics, limits and published lineage browsing. Migration 5 adds
a root-hash index. Paginated lineage includes visible publications across revisions
and forks of the same original, with no private-history enrichment.

## Hub accounts and editor host

The operator CLI creates account keys in exclusive 0600 files and supports listing,
key rotation and disabling/enabling accounts. The hub profile exchanges these keys
for independent cookie sessions, with server-enforced idle/absolute expiry,
revocation and bounded sessions per account. It has no local-session shortcut or
public signup. A request-scoped driver checks the session within every domain SQL
batch, preventing card commits after revocation during uploads or forks.

Migration 4 appends account/session tables and atomic write guards. Seven requirements
pass on both SQLite and local D1, including immutable public actor provisioning.
Ten real-session HTTP/CLI tests cover two-account
publication/fork, private history reads, cookie/origin checks, revocation, in-flight writes and account
changes in another tab. The Node listener defaults to loopback; the hub profile
also accepts wildcard container listeners with a required canonical origin.
Local HTTPS proxy/container behavior is rehearsed as described below. Local Worker account hosting now passes the workerd and browser checks below;
public ingress and remote hosting are not yet proven.

The hub UI now has sign-in, workspaces, file import, the shared editor, explicit
saved-revision selection/review, publication, fork/edit/share, child-fork listing
and visibility restriction. Eight built-server Chromium workflows use CLI-created
accounts: separate-browser publication/fork, expired-session draft recovery and
stale-tab account protection, Archive imports, published lineage navigation, lorebook editing, revision history and asset editing.
The full Vitest suite and 24 Chromium workflows pass in `pnpm check`, along with
lint, type checks, production builds, the Worker dry run, built HTTP smoke and
the separate real-Wrangler browser rehearsal.
The mobile Archive selection and published lineage screenshots were also reviewed.
See `hub-accounts.md` for setup and precise limits.

## Revision history

The card service now exposes authorized, bounded history metadata and individual
revision reads. Pagination pins an upper sequence while new revisions can be saved;
foreign accounts/cards and malformed queries are rejected. All editor hosts inject
the same optional read port and compare saved documents against the current draft.
Comparison preserves missing/null differences, array order and unknown data, pages
all changes and keeps lineage metadata available separately. No read changes the
draft, expected head, original bytes or lineage.

Native/IndexedDB service cases, real-session HTTP checks, editor comparisons and
three Chromium workflows prove immutable reads, pagination, 20 concurrent saves,
stale-head rejection, delayed-read cancellation, network retry and same-account
session recovery. Named snapshots, field restoration and automatic merge remain
unported. See [revision history](revision-history.md).

## Asset revisions and editor

An explicit operation saves the document and complete asset binding map against an
expected head, retaining existing bytes only from that card's base revision. New
uploads are verified and immutable; Foundry validates identity and creates edit
lineage. Atomic head checks and session guards prevent partial card updates on
upload failure, cancellation, stale saves or account revocation. Old revision
assets and accepted original bytes remain readable unchanged.

Five scenarios run on each of SQLite and IndexedDB, and two real-session HTTP
cases cover multipart validation, private reads and revocation during upload.
Verified PNG/CharX round trips preserve supported assets and descriptors; lossy
exports fail explicitly. All editor hosts now inject asset ports for per-instance
upload staging, raster portrait preview, attachment metadata/order/removal and
exact downloads. Five controller tests and three Chromium workflows cover joint
prompt/asset saves, failed and stale saves, session recovery, delayed reads,
browser reload, export/reimport and discard. Media collections, batch tools and
image conversion remain unported. See [asset revisions](asset-revisions.md).

## Text token counts

The shared editor's optional token-count port and Tokens view are implemented in
all three browser hosts. A worker uses the pinned public Foundry encoder with
explicit o200k_base labeling, no silent approximation, bounded inputs and
per-instance cancellation. Five unit tests and three real-browser workflows cover
Unicode counts, lorebook/greeting coverage, failures, isolation and unchanged
originals. The local Worker browser rehearsal checks its asset delivery. See
`text-token-counts.md`; encoding choice, inline counts and AI assistance remain
staged.

## Node container profile

The multistage image starts from a digest-pinned Node 24.19.0 base, fetches the
exact external Foundry commit and installs frozen lockfiles without host SDK or
node_modules copies. The runtime contains bundled API/CLI/web outputs and the
native SQLite dependency closure. Compose runs as UID 1000 with a read-only root,
ephemeral temporary files and a dedicated Unity database/blob volume.

The Linux Docker rehearsal passes native schema readiness, hub and Architect UI
assets, a local HTTPS proxy with explicitly trusted test certificate, canonical
Host/Origin checks, Secure cookie attributes and two CLI-created accounts. An
asset-bearing PNG is edited, published, forked and exported/reimported as CharX.
Original bytes, revisions, copied blobs and account sessions survive container
replacement; disabling an account revokes its session. Both profiles pass image
healthchecks and graceful shutdown. Architect retains a real loopback listener
using Linux host networking and a separate volume.

`runtime/container-rehearsal.json` records the image/platform and checks. A separate
CI job builds and runs the same harness; remote CI execution is pending repo
publication. This closes the current Unity Node container install/restart gate.
Archive has a [separate native rehearsal](archive-native-runtime.md); public
hosting remains unverified. See [containers](containers.md).

## Worker account profile

The Worker now composes the shared account/card/publication services over D1 and
R2 with request-scoped bindings, guarded writes and verified immutable blobs.
HTTP requests validate schema readiness and never run migrations. Operator CLI
commands can instead target an explicit local Worker state directory, using
Wrangler with remote bindings disabled. Login uses a platform rate-limit binding;
canonical URL scheme/origin, cookie and expected-account checks fail closed.

Four workerd cases verify real sessions, asset revisions, selected publication,
second-account fork, CharX export/reimport, exact originals, stale saves, storage
and session persistence, revocation, origin/rate limits and CLI key-file protection.
A separate real-Wrangler/built-hub Chromium rehearsal passes two-account editing,
publishing/forking and restart. It runs in `pnpm check` and records
`runtime/worker-rehearsal.json`. Archive access is now an explicit optional origin
binding, disabled by default. Three additional workerd cases verify copied-source
search, exact D1/R2 imports, revocation, redirect/integrity rejection and an 8 MiB
selection limit before downloads. The Wrangler browser rehearsal also connects
to a separate Node Archive over HTTP, reviews/imports a selection while preserving
an unsaved draft, and reopens exact originals after Worker restart. Its source
SQLite, originals, Lance index and queues remain unchanged. No native Archive
implementation is bundled into the Worker.
Remote resources, operator tooling, ingress and large-request/concurrency limits
remain open. See [Worker profile](worker-profile.md).

## Copied Archive read source

Archive can now open an explicit manifest selection from an isolated standalone
SQLite copy using its own read-only connection. It refuses WAL databases and
sidecars before SQLite opens, follows only contained manifest paths and verifies
bytes before serving. Captured metadata uses the same bounded read index and
client as fixtures; no legacy initialization, migrations, optimizer or queues run.
Five adapter cases, one import/edit integration and built-process HTTP smoke prove
unchanged synthetic-copy databases/files and correct selection/provenance.
JSON responses are also bounded before transmission. Real corpus reconciliation,
LanceDB/search parity and adoption remain unproven. See [copied Archive source](archive-copied-source.md).

## Signed sync transport

The external Foundry development pin now adds an unreleased `/sync` HTTP Message
Signatures profile with required signed body digests, exact actor/key binding,
nonce and operation IDs, bounded freshness and mandatory replay admission through
an application callback. Legacy federation/hash APIs are unchanged. Eight SDK
cases and Unity's actual public-package Node ESM/CJS/workerd consumer verify
independent signatures, bytes, tampering, key binding and callback behavior.
`pnpm check` includes that consumer check.

Migration 6 now stores operator-managed peer/account/workspace grants, scopes,
immutable Ed25519 public keys and actor-wide nonce claims. Shared SQLite/D1
conformance covers concurrent admission, durable restart, rotation/revocation,
strict expiry cleanup, rollback, public SDK integration and populated v5 upgrades.
Migration 7 adds commit-time grant/policy guards and immutable operation receipts
inside the existing publish/fork SQL batches. Nine requirements run on SQLite and
D1: concurrent retries and restart, lost responses, changed-ID conflicts, rollback,
revocation, protected reads, key rotation/actor isolation and populated upgrades.
The shared hub service accepts a verified host context and checks receipts before
fork asset copying. Filesystem/Foundry service tests cover stable lineage and bytes,
retries without new staging and recovery from an interrupted upload. Uncommitted
or losing uploads remain unlinked for future operator cleanup; they are not erased.

The standalone transport consumer still uses a test double; the store tests
exercise real SQL admission and receipts. Node exposes the store programmatically.
The compiled `peers` CLI now generates protected key files, lists/inspects grants,
sets scopes, pins/revokes public keys and performs atomic key rotation. It supports
native SQLite and the existing explicit local D1 profile, with no remote bindings.
CLI tests use both persistent backends and Foundry verification; private keys are
never stored in SQL or printed. A fresh Linux Node container build also passes
the HTTPS/persistence rehearsal with packaged peer inspection and restricted
key-file generation. See [peer operators](peer-operators.md).
Opt-in signed publication reads now use Foundry’s versioned read contract and
client on Node and Workers. SQLite and actual workerd D1/R2 integration verifies
pagination/visibility, identity/lineage, exact asset bytes, policy conflicts and
revoked or replayed credentials. The routes require HTTPS and an explicit pull
grant; browser cookies cannot authorize them. A separate write flag now enables
signed publication/fork commands through Foundry’s command client. Exact selections
and locally granted account/workspace mappings feed the existing atomic receipts;
HTTP tests cover lost responses, duplicate retries, key rotation and revoked
permissions on SQLite and Worker D1/R2. The new signed fork-bundle receiver also
accepts enriched remote documents/assets with an exact source frame and verified
parent/author ancestry. It creates a private draft; publication stays explicit.
Near-limit 8 MiB bundles pass on SQLite and actual D1/R2. Public account actors
can now be provisioned at creation without renaming existing URNs. Shared remote
services persist verified pull snapshots/assets and prepare a selected revision
for return offline. A second persisted Unity account API edits the pulled fork;
restart preserves the exact prepared bytes despite a newer head. Migration 8 now
adds immutable outbound jobs, attempts and acknowledgments on SQLite and D1. The
sender persists the exact frame before dispatch and recovers a lost receipt after
restart and key rotation. Operator-configured connections and account-scoped
browse/pull/prepare/send routes now feed hub review/retry controls. A two-host
Chromium workflow over HTTPS preserves exact attachments and unsaved drafts,
recovers lost preparation/return responses, and publishes the received draft
separately. Local workerd also dispatches returns through a harness bridge and
recovers its D1/R2 jobs after restart. Unreferenced staged final objects now have
operator retirement/sweeps; crash-left temporary uploads, interrupted upload resume
and remote deployment remain open. A fresh container rehearsal covers signed
reads/publish/fork and enriched remote-bundle return over real HTTPS, receipt
recovery after container replacement and account suspension blocking later recovery. This is a server/client proof,
separate from the second-instance service/API and two-host browser tests. Remote
networking and platform limits remain unproven. See [sync sender](sync-sender.md),
[durable return jobs](sync-outbox.md) and [connected hubs](remote-hubs.md) for
evidence and limits.
See [signed sync foundation](sync-foundation.md).

## Next steps

Foundry now has an additive identity/lineage implementation on a separate branch,
with an unreleased normative contract, independent vectors and actual JSON/PNG/CharX
format tests. Unity's `verify:foundry` command tests the built public package
in Node ESM, Node CJS and local workerd and runs during `pnpm check`. `pnpm bootstrap`
prepares the pinned external development dependency used by `packages/cards`.
See `foundry-development.md` for the exact commit.

The Node API now supports a local single-owner session and authorized workspace,
import, save, reopen and original-download operations. Service and HTTP tests cover
actual JSON/PNG/CharX input, opaque fields/assets, stale/concurrent saves, explicit
lineage, workspace isolation and browser-origin rejection. Built-server smoke also
performs an import/edit/reopen/exact-original workflow. Saved-revision exports now run through shared SDK-backed generation and re-import
verification on Node and IndexedDB. JSON without assets and supported PNG/CharX
containers retain identity/lineage; incompatible exports fail explicitly. CharX exports now preserve opaque descriptor metadata and authored names while
allocating distinct paths for names that collide after sanitization. Service tests
and a real browser export/reimport verify those cases. The UI exposes downloads
in both Architect profiles and the hub. Basic asset editing is implemented;
the remaining rich editor tools and media collections remain incomplete. See `card-export.md`.

An explicit Foundry SillyTavern JSON transport profile now reverses only verified
transport additions and retains the original identity/lineage. `pnpm verify:sillytavern
/path/to/SillyTavern` passes the actual fixture Archive → edit → selected publication
→ second-account fork → SillyTavern JSON export/reimport flow with unchanged
originals. An actual external prompt edit is rejected before writes. This is a
text-card JSON result, now joined by a verified PNG portrait/alias flow. Alice
explicitly uploads an encoder-produced portrait before publication; exact image
bytes, descriptors and lineage survive Bob's real-application round trip. Actual
external portrait edits and ordinary PNG re-encoding are rejected before imports
write cards, and separate attachments are refused by the profile. General image
conversion, separate attachment transport and live Archive adoption remain open. No hash exclusions or silent lineage repairs were added.

The Archive read client and opt-in fixture service now implement bounded
list/filter/search, immutable snapshot pagination, exact subset manifests,
source provenance and verified original/asset reads. Ten requirements run through
the actual Hono service/client, including real HTTP cancellation/redirect checks.
`runtime/archive-conformance.md` records the results. Built-server smoke checks
also cover default-off and fixture modes. An explicit copied-SQLite adapter now passes five synthetic-copy cases and a
selection-import integration, with unchanged database/files and queue sentinels.
Built HTTP smoke also exercises copy mode. Real copied-corpus rehearsal and live
database/search adapters remain outstanding; see `archive-read-contract.md`.

The separate Archive image now passes a clean Node 24.19.0/Linux amd64 native
installation and restart rehearsal with better-sqlite3 13.0.3, LanceDB 0.37.1 and Arrow
18.1.0. Synthetic FTS/phrase/filter/sort and exact-vector queries survive process
and container replacement. Copied-mode HTTP reads run as uid 1000 with the data
volume mounted read-only; original, SQLite and Lance file inventories/digests stay
unchanged. `pnpm check` and container CI include these probes. This closes the
native installation gate for that platform, not production search parity. See
`archive-native-runtime.md` for query-shape findings and evidence limits.

An explicit copied Lance index now powers the separate `/search` read API and
portable client. Pinned versions, full bounded file inventories/digests and exact
selection-ID coverage prevent silently mixing snapshots. Native tests cover
phrase/Boolean search, complete-set NOT, stable relevance/title/ID ordering,
metadata filters and query-bound pagination; restart and read-only container
rehearsals include the endpoint. Original bytes and queue sentinels stay unchanged.
The shared Archive browser now discovers that capability and offers card-text
search in local Architect, browser-only Architect and the Node hub. It retains
the applied query/order/filter across pages, reviews exact selections and keeps unsaved
drafts through additional imports. Workspace/session authorization is rechecked
after remote reads, with hub reauthentication retaining the page and selection.
Typed advanced filters now support comparisons, ranges, membership, existence and
Boolean groups over fields present in the pinned index. They constrain the full
NOT universe and are bound into pagination cursors. Native tests cover legacy
examples, nullable fields, aliases, quoted values and malformed inputs.
The read API and shared browser now support explicit filter-only browsing and all
22 legacy numeric/date order names when their columns have supported types. Native
queries order the complete filtered set before pagination, retaining same-direction
ID ties and nulls last. Hand-authored row expectations cover every order in text,
Boolean and browse modes; a 150-row case verifies ordering beyond a top-k window.
Thirteen Chromium search workflows use a real synthetic SQLite/Lance copy; the
root check verifies its complete file inventory again after browser shutdown.
Semantic/hybrid reads now accept a pinned copied vector table and an explicitly
configured Ollama/OpenAI-compatible query provider. Exact cosine search deduplicates
all chunks before paging; weighted fusion and title priority preserve legacy
ranking intent. Partial coverage is advertised. A result digest prevents changed
provider responses from silently changing subsequent pages. The shared UI includes
semantic/hybrid modes and matched excerpts. Provider, native and browser cases use
synthetic inputs without external model calls. See `archive-semantic-search.md`.
An explicit lexical generation command now copies a prepared selection into a new
directory, projects legacy SQLite metadata with a fixed scoring date, builds and
validates its FTS index, and publishes the manifest last. Original/cache bytes and
SQLite queues stay unchanged. Native tests cover score goldens, timezones, failure
and publication boundaries; the container rehearsal builds and reopens a synthetic
generation read-only. See `archive-generations.md`. The Worker can now configure
the same read client through an optional origin binding; its local workerd and
Wrangler rehearsals include copied Archive reads/imports. The explicit semantic
generation command now follows legacy Lance whole-card projection, with bounded
serial Ollama/OpenAI-compatible batches, input and Float32 row digests, recorded
truncation, and publication only after both tables and source files validate.
Provider failures, cancellation and source mutation leave the generation
unpublished. Native process/container probes use synthetic loopback providers and
reopen generated semantic/hybrid reads without changing copied bytes. Actual
model quality, real-corpus parity and live adoption remain. See `archive-search.md`.

| Step | Dependency | Acceptance |
|---|---|---|
| Canonical identity and lineage in Foundry | Additive API consumed through a pinned external development checkout; contract review/release remain | Field sensitivity, key-order stability, JSON/PNG/CharX round trips and distinct revision hashes pass. Unity uses preserving CharX exports; opaque descriptor metadata and colliding asset filenames now retain identity and bytes. |
| Shared store and migrations | Store, verified assets, immutable sources and initial card HTTP/domain operations implemented | Node/local-D1 rollback, failure injection, upgrades, head conflicts, concurrent edits and separate content/revision identity are tested. |
| Archive read client and fixture service | Read contract and selection import implemented; live adapter remains separate | Exact bytes/hash, stable selection, asset bindings, per-card source preservation, auth and absence of Archive writes pass on fixture data. |
| Extract editor core | Per-instance controller, field forms and local API host implemented | Two isolated drafts, API/browser save/reopen, cross-tab conflicts, unknown fields and immutable sources pass. Rich tool ports remain. |
| Hub publish/fork | Account profile, shared editor, selection/review, publishing and fork UI implemented | Exact subset, source/descendant access, real second-user browser sessions and draft recovery pass. Archive selection and visible published lineage browsing pass. External interoperability and remote hosting remain. |
| Interoperability slice | Explicit SillyTavern JSON transport and actual application harness implemented | Fixture Archive → edit → exact publication → real second-user fork → SillyTavern JSON reimport passes with unchanged original bytes and identity; meaningful external edits fail. A supported PNG portrait/alias also survives; changed portraits and separate attachments fail explicitly. General asset transport and live adoption remain unproven. |
| Remaining ports and profiles | Proven slice | Node container clean install, local HTTPS and storage/session persistence pass on Linux amd64. The separate Archive SQLite/LanceDB native container and read-only restart checks pass. Feature parity, optional integrations, Archive search ports/parity and remote Workers validation remain. |
| Archive adoption | Read API and copied-data rehearsal | Recoverable snapshot/manifest, single writer, LanceDB/search parity, immutable accepted bytes, rollback. |

The first slice is not complete until the real external application round trip
passes. A Foundry-only round trip or a fixture-only Archive is insufficient.
Reserve existing rich editor features rather than silently deleting them; mark
unported capabilities explicitly. Remove legacy candidates only after checking
dynamic and external callers, not just literal import counts.

## Deferred operational work

No app freeze tags, maintenance notices, remote repo creation, production ingress,
secrets, live/remote database connections, data migration or deployment are included here.
The Node store uses a new local Unity database. Clean Node container/native SQLite
and separate Archive LanceDB installation/reopen checks pass on Linux amd64.
Other native platforms, full search parity and real copied-corpus adoption remain
unverified; the live Archive is untouched.
