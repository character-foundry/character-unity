# Character Unity

One application for a character library, Archive, editing and sharing. Foundry
remains an independent SDK for character formats and federation primitives.

`apps/web` is the active native React Router application in both local and account
profiles. Its library grid, card menus, viewer, search, sharing and connected-hub
pages share one shell, with no Next shims or old CardsHub server fallbacks.
The Architect editor uses native Unity imports, revisions and staged assets;
explicit Save commits text, portraits and attachments together. New/Fork drafts
create nothing until Save, and history restores include their assets. Each editor
owns its workspace, draft, assets, expected revision heads and request lifetime.
See [current editor status and remaining gaps](docs/editor-port.md).

[Sharing](docs/hub-accounts.md#native-sharing-workflow) reviews and publishes
1–20 exact saved revisions, including historical revisions. Later saves do not
change that selection. Publication policy controls visibility, forks and original
downloads; visible lineage never loads private revision history.
[Connected hubs](docs/remote-hubs.md) supports configured peers, private pulls and
reviewed saved returns with explicit send/retry. The browser never supplies peer
URLs or signing keys.

The host explicitly advertises its local/account profile. Every library client
captures one authenticated actor and workspace for JSON requests and binary
downloads. Account expiry or an account change requires recovery as the same
account; switching accounts disposes the previous client and editor sessions.
Browser LLM credentials and direct provider requests are local-install features
and are disabled in the hub profile. Templates, presets and editor preferences
remain available. These browser features do not provision a publicly hosted hub.

Existing Archive database/files/LanceDB stay in place. Live writer takeover is
on hold, along with live embedding-provider acceptance. The pinned Foundry commit
is now public and fetchable; its identity/sync APIs remain unreleased npm features.
Archive favorites now add exact-version library references, not copied cards.
Unchanged reads and editor drafts resolve through Archive; the first changed Save
creates an owned fork and retains inherited asset locators. File import checks
exact bytes, then Foundry content/asset identity across both stores. The native
Archive page exposes lexical, Boolean, semantic, hybrid and indexed-filter modes,
with explicit provider, coverage and failure reporting. A reference-only Archive
link cannot be published or returned to a remote hub; first save a changed owned
fork. An unchanged Save deliberately creates no copy. See
[in-place setup and explicit indexing gates](docs/archive-existing-storage.md).

The earlier Architect/hub scaffolds and form editor are retired. Local API,
account and browser-only profiles use the same native UI. The browser profile
keeps its existing IndexedDB database and upgrades in place; retirement does not
discard stored cards. Content supports standalone lorebooks, presets and personas
with exact originals and immutable revisions. Statistics reports the selected
workspace and explicit Archive coverage. See [implementation status and open
gates](docs/implementation.md). No live data, accounts or secrets are included.

[Meta-tags](docs/meta-tags.md) provides a graphical editor for workspace-owned tag
groups and spelling variants. Select groups in Library or Archive filters;
explicit Save changes only grouping metadata, never card tags or original files.

## Run locally

Use Node **24** (tested with 24.19.0) and **pnpm 11.20.0**.

```sh
pnpm bootstrap
pnpm dev
```

| Process | Address | Independent command |
|---|---|---|
| Unified application | http://127.0.0.1:9430 | `pnpm dev:web` |
| Shared API | http://127.0.0.1:9312/api/health | `pnpm dev:api` |
| Archive service | http://127.0.0.1:9313/api/health | `pnpm dev:archive` |
| Native browser-only profile (optional) | http://127.0.0.1:9310 | `pnpm dev:browser` |

`pnpm dev` starts the unified web application and one API process. Archive starts separately;
its default mode opens no database or search/scraper jobs. Explicit copied-SQLite
mode reads only an isolated manifest selection; see [copied Archive source](docs/archive-copied-source.md). Architect
uses the API for sessions and persistence. This default command uses the local
single-owner profile. The same web application supports hub sign-in when its API
uses the account profile; follow
[hub accounts and setup](docs/hub-accounts.md). Vite proxies `/api` during development.

Open the unified application, choose a workspace from the account menu, then import
a wrapped CCv2/CCv3 JSON, PNG or CharX card. Edit and save explicit revisions.
Reopen saved cards after a reload and download the exact accepted original.
Use the card menu or viewer to export
a verified JSON/PNG/CharX copy; [export limits and compatibility](docs/card-export.md)
describe supported cases and explicit loss rejection. A stale draft stays open after a save
conflict; discard/close it and reopen the current revision when ready.

For a built, same-origin local app, run from the repository root:

```sh
pnpm build
UNITY_WEB_DIR=apps/web/dist node apps/api/dist/node.js
```

Open `http://127.0.0.1:9312`. This is still the loopback, single-owner profile.
Known client routes support direct reloads; API misses never fall back to HTML.
Run `pnpm test:e2e:unity` to build and test the active application in Chromium.
For the hub, create accounts and start the explicit account profile as described
in [hub accounts](docs/hub-accounts.md). A dependency-locked Node container serves
either profile; see [containers](docs/containers.md) for hub Compose, native local
Unity on Linux, account setup and the HTTPS/persistence rehearsal. Remote
deployment remains outstanding.

For browser-only storage, use `pnpm dev:browser`, or run `pnpm build:browser`
and serve `apps/web/dist-browser` with a static web server with SPA fallback. This profile
requires no API. It uses IndexedDB for revisions and original/asset bytes and
calls the same Foundry-backed card service in the browser. Use localhost or HTTPS
for Web Crypto. Data belongs to that site's origin and browser profile; it does
not automatically move between the browser profile and local API profile.
Editing/import/save work offline after the page loads; offline page reload and
installation are not implemented. See [browser storage](docs/browser-storage.md).

For the in-house application, follow
[existing Archive storage](docs/archive-existing-storage.md) to use the existing
database, originals and LanceDB in place. Archive is the ingestion/search
foundation; Unity supplies presentation, editing, forks and sharing.

Run `UNITY_ARCHIVE_MODE=fixture pnpm dev:archive` to enable synthetic Archive
list/search, stable selection manifests and exact original reads. To connect
the native app, follow [existing Archive storage](docs/archive-existing-storage.md). Default mode
is `off`, with read routes reporting 503. See [the read contract](docs/archive-read-contract.md).

Node hosts accept `HOST` (default `127.0.0.1`) and `PORT`; the API's local session
mode requires a loopback host. No env file is required
or automatically loaded. Web dev ports are fixed and fail if occupied.

The Node API owns `apps/api/runtime/unity.db` by default. `UNITY_DB_PATH` may select
another Unity database or `:memory:` for an ephemeral session; never point it at
Archive's database. Startup validates/applies Unity migrations and rejects
unfamiliar databases. `GET /api/ready` checks schema readiness separately from
process health. The local API supports authenticated workspace creation, JSON/PNG/CharX
imports, revision saves and exact-original downloads; see [the card workflow](docs/card-workflow.md).
The Worker has a local D1/R2 account profile. It reports storage unavailable until
operator migration; see [Worker setup and verification](docs/worker-profile.md).

Byte storage defaults to `apps/api/runtime/blobs`; `UNITY_BLOB_DIR` selects another
Unity-owned directory. Uploads are verified before completion and existing objects
cannot be overwritten. Publication and card-revision asset downloads are available.
Explicit asset revision/upload routes are connected to the native editor.
Remote R2 configuration remains pending. See [asset revisions](docs/asset-revisions.md)
and [the asset lifecycle](packages/assets/README.md). Explicit `pnpm assets`
commands preview, retire and sweep old unreferenced objects; see
[asset maintenance](docs/asset-maintenance.md).

```sh
pnpm exec playwright install chromium --only-shell  # once per browser update
pnpm check                 # lint, types, tests, builds, Worker dry run, smoke, browser tests
pnpm build                 # static web outputs and bundled Node executables
pnpm build:worker          # native account UI/API bundle; no Cloudflare deployment
pnpm build:worker:browser  # native browser-only static Worker bundle
pnpm dev:worker            # local Worker API; initialize its separate state first
pnpm verify:worker         # native UI + local Wrangler, accounts, light profile and restart
pnpm verify:sync ../.unity-foundry-sdk/packages/character-foundry # public signed transport/read checks
docker build -t character-unity:foundation .
pnpm verify:container character-unity:foundation # isolated Linux Docker rehearsal
pnpm verify:archive-native # built Archive SQLite/LanceDB process rehearsal
docker build --target archive -t character-unity-archive:foundation .
pnpm verify:archive-container character-unity-archive:foundation
```

The Node and Worker API alternatives both use port 9312; run one at a time.
Generated Worker types and build outputs are ignored. `pnpm type-check` generates
the types first. Built Node hosts run with
`pnpm --filter @character-unity/api-host start` and
`pnpm --filter @character-unity/archive start`. The active static output is
`apps/web/dist`; browser-only output is `apps/web/dist-browser`.
Archive's separate native image and synthetic search/restart checks are described
in [Archive runtime](docs/archive-native-runtime.md). Fixture/copied modes remain
for isolated rehearsals; the active in-house path reads existing storage in place.
Real-source runs, provider quality and coordinated writer takeover remain open.

## Ownership

- `apps/archive`: local Archive service; owns the existing database, originals and LanceDB.
- `apps/web`: active library, Archive, viewer, Architect editor, sharing and connected-hub UI.
- `apps/api`: Node and Workers entrypoints for the shared API.
- `packages/api`: portable Hono routes used by both hosts.
- `packages/store`: common schema/repositories, native SQLite and D1 adapters,
  versioned migrations and a shared conformance suite.
- `packages/blob-store`: verified immutable bytes on filesystem/R2.
- `packages/browser-storage`: atomic IndexedDB revisions, sources and verified blobs.
- `packages/assets`: upload completion, retry and workspace-scoped asset reads.
- `packages/cards`: authorized import/save, publication and fork operations using Foundry identity and immutable sources.
- `packages/content`: standalone typed JSON originals, revisions, forks and local sharing.
- `packages/archive-client`: bounded, verified reads from the independent Archive service.
- `packages/architect`: active session-isolated native editor.
- `packages/tokenizer`: browser token worker shared without importing scaffold editor UI.
- `packages/scraper-kit`: plugin contracts shared by the Archive source adapters.

Foundry is consumed through an explicit development link to a pinned external
checkout. `pnpm bootstrap` prepares sibling `.unity-foundry-sdk`; it refuses to
reset existing work. `pnpm check` verifies the link and tests its public identity
API on Node and Workers. See [SDK development](docs/foundry-development.md).

See [architecture decisions](docs/architecture.md) and
[implementation gates](docs/implementation.md) before beginning the ports.
See [hub publication](docs/hub-publication.md) for backend policy and API routes.
Public resource provisioning/deployment and live Archive activation remain separate gates.
