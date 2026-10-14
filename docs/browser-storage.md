# Browser storage profile

`pnpm dev:browser` starts the native Unity UI. `pnpm build:browser`
creates `apps/web/dist-browser` for a static server with SPA fallback. This is an explicit
build profile; a failed API connection never silently switches storage backends.
Use localhost or HTTPS for Web Crypto. The static host needs only the index and
built assets. No API, server database, cookies or hosted account is required.
The browser profile does not advertise Archive/search-index administration,
chat placement, hub accounts, signed sharing or configured remotes. It never
falls back to host API requests. The account Worker is a separate profile;
see [Worker hosting](worker-profile.md) for both native builds.
The dev origin remains `http://127.0.0.1:9310`, matching the retired browser host.
For a static installation, keep its previous scheme, host and port: the same
database name at a different origin does not expose that origin's existing data.

An explicit `VITE_UNITY_ARCHIVE_ORIGIN` connects read-only native Archive access.
For development, set Archive's `UNITY_ARCHIVE_READ_ORIGINS=http://127.0.0.1:9310`
and build/run the browser profile with its Archive origin. Static deployments
must allow their exact site origin instead. The default has no connection.
Only public GET/HEAD reads are granted; credentials, administration, private
workspace searches, writes and preflights receive no CORS permission. Favorites
add pinned references. Changed Save makes an owned fork with inherited locators;
reload, original downloads and exports read through Archive without copying files.
Disconnected sources remain explicitly unavailable. No hosted API fallback occurs.

The browser host supplies a local profile actor and composes the existing
`packages/cards` / `packages/assets` services with `packages/browser-storage`.
The same public Foundry SDK parses containers and computes identity/lineage in
both profiles. Editor state remains per instance; IndexedDB is the persistence
layer, not a replacement global draft store.

## Data and transactions

The database is still `character-unity:architect`, now schema version 4. Its namespace and
format marker differ from every server/Archive database. Object stores hold
workspaces, cards, revisions, immutable source references, assets and verified
blobs. Compound indexes provide scoped, bounded pagination. The schema is versioned
separately from SQL migration numbers. Future upgrades must append migrations;
current code refuses unfamiliar/newer schemas instead of resetting them.
The additive upgrade retains cards, revisions, sources, blobs, favorites, history
and search-job sequence state. Schema 4 adds standalone content stores; it does
not copy or reset the existing library. Use the same site origin to retain access.

Each create/save/fork runs in one native readwrite transaction. Head comparison and
head advancement share that transaction, so two tabs cannot both overwrite the
same expected head. Source/revision writes abort together if any reference is
foreign, missing, staged or if storage fails. Domain operations expose no mutator
for revisions or sources. As with any client-side store, a same-origin script or
the browser operator can access IndexedDB directly; this is not a hosted trust
boundary or authorization mechanism.

The internal transaction helper accepts only a synchronous generator yielding IDB
requests. It resumes inside request success events and resolves after `complete`.
Network calls, stream consumption and hashing happen outside write transactions.
This follows the [IndexedDB transaction lifecycle](https://www.w3.org/TR/IndexedDB/).

Blobs are limited to 32 MiB per object. The adapter buffers a bounded verified
stream into a Blob because IndexedDB writes a value atomically. SHA-256 and length
are checked before publication; retry reads verify existing bytes. Different bytes
cannot replace an existing key. Asset completion happens afterward through the
shared service. A quota error or interruption can leave staged/unreferenced bytes.
Settings → Browser storage provides an explicit read-only preview and reviewed
cleanup. There is no idle/background collection. Deleted-card cleanup protects
live history, source bytes and recursive fork ancestors; Archive bytes are never
eligible. Unknown orphan bytes must first be explicitly observed. Both paths
require at least 24 hours, recheck the graph in one write transaction and fence
retired keys against late writers. Immutable metadata is retained.

## Profile behavior

- Libraries belong to a site origin and browser profile. Separate origins/profiles
  have separate databases. They do not synchronize with the local Node API.
- Saved cards reopen after reload. Text recovery drafts retain their existing
  owner-scoped behavior; staged files and unsaved New/Fork drafts remain in memory.
  Explicit discard and navigation prompts protect dirty editors.
- After the application loads, import/edit/save/download need no network. Page
  reload still needs the static assets; no service worker/offline installation yet.
- Clearing site storage or browser eviction can remove the library. Keep source
  files. Node's `pnpm backup` does not back up IndexedDB; browser library-wide
  backup/export and persistent-storage UX remain outstanding.
- Quota failures keep drafts open and report the storage failure. A version change
  in another tab closes old connections; preserve unsaved text and reload.
- Originals are downloaded from stored bytes; remote assets are never fetched to
  repair an import. Existing unsupported/lossy-format restrictions still apply.

## Evidence

The adapter tests cover atomic rollback after partial writes, quota errors,
workspace/reference boundaries, immutable inputs, two-connection head conflicts,
reopen, pagination/forks, verified blob retry/cancellation and schema rejection.
Foundry card-service and standalone content cases run on native storage and emulated
IndexedDB. `pnpm test:e2e:browser` uses only a static server and exercises
JSON/PNG/CharX, offline edits after load, exact originals, actual reload, two tabs,
separate profiles, failed-save retry, additive upgrades, exact standalone originals,
unsafe numeric JSON refusal and explicit reviewed cleanup. A fake IndexedDB test alone is not treated
as browser evidence. Firefox/WebKit and browser eviction recovery remain untested.
`pnpm test:e2e:browser-archive` separately verifies explicit cross-origin reads,
references/forks/reload/exact inherited bytes, zero copied blobs and unchanged
Archive SQL/originals/versions/Lance state using disposable fixtures.
