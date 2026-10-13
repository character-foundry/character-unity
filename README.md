# Character Unity

One repository for Archive, Architect and a character-sharing hub. Foundry remains
an independent SDK for character formats and federation primitives.

The active application is `apps/web`: one library/Archive/viewer/editor shell.
Its Architect editor now uses native Unity imports, revisions and staged assets;
portraits and attachments are committed together on explicit Save. New/Fork
drafts create nothing until Save, and history restores include their assets.
Browser-local AI settings, templates, presets and wizard remain supported;
nonexistent old-server modules and duplicate import/storage paths are removed.
See [current editor status and remaining gaps](docs/editor-port.md).

Existing Archive database/files/LanceDB stay in place. Live writer takeover is
on hold. Archive-reference favorites/import deduplication and the native viewer
rewrite without Next shims are subsequent work, not completed features.

The following foundation history describes the earlier standalone/scaffold
profiles, which remain available for regression checks pending retirement:

**Status: runnable foundation; feature migration remains staged.** Architect has a working core editor with two
independent drafts; hub mounts the same editor with account sign-in and publishing.
Both include embedded lorebook settings and entry editing, copying and ordering.
The [lorebook file workflow](docs/lorebook-files.md) reviews native JSON imports
before replacing a draft's book and downloads current lorebook edits.
The shared History view compares saved revisions with a draft without replacing it.
The Assets view stages portraits and attachments per draft, with explicit saves,
preview, ordering, removal and exact downloads.
The shared [Tokens view](docs/text-token-counts.md) counts draft text locally in
an on-demand browser worker, with explicit coverage and error reporting.
The shared store now supports workspaces, atomic revisions, forks and asset
metadata on Node SQLite and local D1. The Node API initializes its own database;
its asset service has verified filesystem/R2 byte adapters.
Card import/save/original-download routes now use Foundry identity and local sessions.
The separate Archive service offers opt-in fixture and copied-SQLite read APIs,
plus [lexical/Boolean search](docs/archive-search.md) over an explicit copied Lance
index. Both Architect
profiles and the hub can review and import an exact Archive selection through the
same browser component, with card-text search, typed advanced filters, filter-only
browsing and supported numeric/date ordering when the copied index is configured.
Opt-in [semantic and hybrid search](docs/archive-semantic-search.md) uses a pinned
vector copy and an operator-configured query provider, with matched excerpts.
Explicit [lexical and semantic generation commands](docs/archive-generations.md)
build new searchable copies from prepared SQLite metadata with a fixed scoring
date; semantic builds use an explicitly configured embedding provider.
The [Worker profile](docs/worker-profile.md#archive-reads-and-imports) can configure
the same Archive read source and import verified originals into D1/R2.
The shared API now
supports selected-revision publication and permission-checked forks. Operator-created
accounts have expiring/revocable sessions. Signed-sync transport and durable peer/replay
admission are implemented, along with atomic publish/fork receipts.
[Peer operator commands](docs/peer-operators.md) support Node and local D1;
[signed publication reads](docs/sync-foundation.md) are available behind an
HTTPS-only opt-in. Signed publish/fork commands have a separate write flag.
Remote fork bundles verify parent lineage and exact assets before creating a
private draft. [Sender services](docs/sync-sender.md) now support public account
identities, persisted remote pulls and offline return preparation. [Durable return
jobs](docs/sync-outbox.md) preserve exact selections and recover lost acknowledgments
after restart. The hub now has [configured remote browsing and return controls](docs/remote-hubs.md),
including explicit review and retry.
The hub browses visible published
revisions and forks sharing an original, with explicit parent links. Rich editor
tools and live Archive search/scraping still need porting. Remote deployment and
optional federation integrations remain open.
No live data, accounts or secrets are included. The editor field metadata is
extracted from Architect; Foundry stays an external dependency.

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
| Legacy Architect scaffold | http://127.0.0.1:9310 | `pnpm dev:architect` |
| Legacy hub scaffold | http://127.0.0.1:9311 | `pnpm dev:hub` |

`pnpm dev` starts the unified web application and one API process. Archive starts separately;
its default mode opens no database or search/scraper jobs. Explicit copied-SQLite
mode reads only an isolated manifest selection; see [copied Archive source](docs/archive-copied-source.md). Architect
uses the API for sessions and persistence. This default command uses the local
single-owner profile. Hub sign-in needs the account profile; follow
[hub accounts and setup](docs/hub-accounts.md). Vite proxies `/api` during development.

In Architect, connect to the local library, create a workspace, then import a
wrapped CCv2/CCv3 JSON, PNG or CharX card. Edit and save explicit revisions.
You can open two independent drafts, reopen saved cards after a reload and
download the exact accepted original. Use **Download saved revision** to export
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
either profile; see [containers](docs/containers.md) for hub Compose, standalone
Architect on Linux, account setup and the HTTPS/persistence rehearsal. Remote
deployment remains outstanding.

For browser-only storage, use `pnpm dev:browser`, or run `pnpm build:browser`
and serve `apps/architect/dist/browser` with a static web server. This profile
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
Architect or hub, follow [Archive selection import](docs/archive-import.md). Default mode
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
Explicit asset revision/upload routes are connected to all editor hosts.
Remote R2 configuration remains pending. See [asset revisions](docs/asset-revisions.md)
and [the asset lifecycle](packages/assets/README.md). Explicit `pnpm assets`
commands preview, retire and sweep old unreferenced objects; see
[asset maintenance](docs/asset-maintenance.md).

```sh
pnpm exec playwright install chromium --only-shell  # once per browser update
pnpm check                 # lint, types, tests, builds, Worker dry run, smoke, browser tests
pnpm build                 # static web outputs and bundled Node executables
pnpm build:worker          # local bundle only; no Cloudflare deployment
pnpm dev:worker            # local Worker API; initialize its separate state first
pnpm verify:worker         # built hub + local Wrangler, two accounts and restart
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
`pnpm --filter @character-unity/archive start`. Static outputs live in
`apps/architect/dist` and `apps/hub/dist`.
Archive's separate native image and synthetic search/restart checks are described
in [Archive runtime](docs/archive-native-runtime.md). Its public read search still
uses the fixture/copied contract; full legacy search parity remains open.

## Ownership

- `apps/archive`: local-only Archive; owns its future DB, original files and LanceDB.
- `apps/architect`: standalone editor host, with local API and browser-only storage profiles.
- `apps/hub`: sharing host, fresh start with no old CardsHub database migration.
- `apps/api`: Node and Workers entrypoints for the shared API.
- `packages/api`: portable Hono routes used by both hosts.
- `packages/store`: common schema/repositories, native SQLite and D1 adapters,
  versioned migrations and a shared conformance suite.
- `packages/blob-store`: verified immutable bytes on filesystem/R2.
- `packages/browser-storage`: atomic IndexedDB revisions, sources and verified blobs.
- `packages/assets`: upload completion, retry and workspace-scoped asset reads.
- `packages/cards`: authorized import/save, publication and fork operations using Foundry identity and immutable sources.
- `packages/archive-client`: bounded, verified reads from the independent Archive service.
- `packages/archive-browser`: shared Archive search, selection and import UI with an injected host port.
- `packages/ui`: shared React presentation and CSS, with no application state.
- `packages/editor`: per-instance draft controller, core CCv2/CCv3 field forms and injected save port.
- `packages/scraper-kit`: reserved boundary; no runtime implementation yet.

Foundry is consumed through an explicit development link to a pinned external
checkout. `pnpm bootstrap` prepares sibling `.unity-foundry-sdk`; it refuses to
reset existing work. `pnpm check` verifies the link and tests its public identity
API on Node and Workers. See [SDK development](docs/foundry-development.md).

See [architecture decisions](docs/architecture.md) and
[implementation gates](docs/implementation.md) before beginning the ports.
See [hub publication](docs/hub-publication.md) for the initial backend policy,
API routes and remaining hosting/UI work.
