# Native host retirement

The native `apps/web` application replaces the earlier `apps/architect` and
`apps/hub` hosts. `packages/editor`, `packages/ui` and `packages/archive-browser`
are removed after their useful workflows moved to native components. The active
editor remains `packages/architect`; tokenization remains `packages/tokenizer`.
Deleted tracked source and tests are recoverable from Git. This removes no live
database, original bytes, browser site storage or ignored build directory.

## Profiles and regression replacement

| Earlier workflow | Native coverage |
| --- | --- |
| Core forms, imports, assets, portraits, exact originals | `e2e/unity-editor/editor.spec.ts`, `core-fields.spec.ts`, `media.spec.ts` |
| Read-only history, expected-head conflicts, side-by-side/unified comparison | `e2e/unity-editor/history.spec.ts` and isolation cases |
| Embedded lorebooks, native JSON files, library replacement | `e2e/unity-editor/lorebook.spec.ts`; paged/searchable sources beyond 100 |
| Strict worker token counts and failure/retry | `e2e/unity-editor/tokens.spec.ts` |
| Archive search, immutable pinned membership and originals | `e2e/unity-editor/search.spec.ts`, `references.spec.ts` |
| Account publication/policies/forks and HTTPS remote returns | `e2e/unity-editor/sharing.spec.ts`, account Playwright profile |
| IndexedDB/offline/reload/conflicts/upgrade/quota behavior | `e2e/native-browser`; static native browser-only build |
| Browser cleanup, statistics and standalone typed JSON | Native browser cases plus corresponding API-profile suites |

The old copied-Archive subset-import presentation is not carried forward as a
second storage architecture. Native favorites/adds retain exact Archive references;
only a changed Save creates an owned fork. Read/export must not change the Archive.
The native fixture verification separately checks original SQL/file/Lance state
while permitting explicit Unity projection tables in the same Lance database.

`pnpm test:e2e` runs native local, account and browser profiles sequentially,
then the browser profile's explicit cross-origin Archive attachment rehearsal.
Direct `playwright test` defaults to the native local profile. No retired host
is staged into the Node distribution or Worker static assets.

## Existing browser data

The database name remains `character-unity:architect`; the browser actor remains
`browser` / `urn:unity:user:browser`. Additive schema4 retains saved cards, raw
originals, revisions, favorites and queued job sequence state. It adds standalone
content stores, not a copied library. `pnpm dev:browser` retains its prior
`http://127.0.0.1:9310` origin; static hosts must likewise retain their prior
scheme/host/port. Use the same origin/browser profile.
The browser runtime hosts portable services in-process and never redirects failed
storage operations to a server API. Browser-only capabilities are declared, not
guessed from failed account requests.

Old scaffold drafts were transient in-memory controllers. Native text-recovery
namespaces stay untouched; staged files and unsaved New/Fork drafts are still
memory-only. No full-library browser backup or eviction recovery is claimed.

## Separate legacy repositories

Architect and Federation now carry maintenance-only README notices and local
annotated `unity-legacy-baseline-2026-10-13` tags. Notice commits are Architect
`2dbb7a9` and Federation `1b69a72`. The Architect worktree's 20 pre-existing
changes remain untouched and are **not** included in its tag. They require a
separate reconciliation decision; no reset, merge, discard or push was performed.
The Archive writer is not frozen/stopped by this change. Live takeover remains held.
