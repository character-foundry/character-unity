# Browser storage profile

`pnpm dev:browser` starts Architect with its browser host. `pnpm build:browser`
creates `apps/architect/dist/browser` for a static server. This is an explicit
build profile; a failed API connection never silently switches storage backends.
Use localhost or HTTPS for Web Crypto. The static host needs only the index and
built assets. No API, server database, cookies or hosted account is required. An optional
`VITE_UNITY_ARCHIVE_ORIGIN` enables explicit Archive reads/imports; see
[Archive selection import](archive-import.md). No Archive request occurs until
the user opens that workflow.

The browser host supplies a local profile actor and composes the existing
`packages/cards` / `packages/assets` services with `packages/browser-storage`.
The same public Foundry SDK parses containers and computes identity/lineage in
both profiles. Editor state remains per instance; IndexedDB is the persistence
layer, not a replacement global draft store.

## Data and transactions

The database is `character-unity:architect`, schema version 1. Its namespace and
format marker differ from every server/Archive database. Object stores hold
workspaces, cards, revisions, immutable source references, assets and verified
blobs. Compound indexes provide scoped, bounded pagination. The schema is versioned
separately from SQL migration numbers. Future upgrades must append migrations;
current code refuses unfamiliar/newer schemas instead of resetting them.

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
shared service. A quota error or interruption can leave staged/unreferenced bytes;
cleanup/garbage collection remains future work, as it does for server storage.

## Profile behavior

- Libraries belong to a site origin and browser profile. Separate origins/profiles
  have separate databases. They do not synchronize with the local Node API.
- Saved cards reopen after reload. Unsaved drafts remain in memory, with explicit
  discard on close and a navigation prompt; no crash-recovery autosave is claimed.
- After the application loads, import/edit/save/download need no network. Page
  reload still needs the static assets; no service worker/offline installation yet.
- Clearing site storage or browser eviction can remove the library. Keep source
  files. Library backup/export and persistent-storage UX remain outstanding.
- Quota failures keep drafts open and report the storage failure. A version change
  in another tab closes old connections; preserve unsaved text and reload.
- Originals are downloaded from stored bytes; remote assets are never fetched to
  repair an import. Existing unsupported/lossy-format restrictions still apply.

## Evidence

The adapter tests cover atomic rollback after partial writes, quota errors,
workspace/reference boundaries, immutable inputs, two-connection head conflicts,
reopen, pagination/forks, verified blob retry/cancellation and schema rejection.
All seventeen Foundry card-service cases run on native storage and emulated
IndexedDB. Chromium tests use only a static server for this profile and exercise
JSON/PNG/CharX, offline edits after load, exact originals, actual reload, two tabs,
separate profiles and failed-save retry. A fake IndexedDB test alone is not treated
as browser evidence. Firefox/WebKit and browser eviction recovery remain untested.
