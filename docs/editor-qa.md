# Editor validation inventory

## Active unified application

Current aggregate: `pnpm test:e2e` builds and runs native local, real account/TLS
and static browser-only suites sequentially. `pnpm check` adds module/conformance,
types, lint, smoke, SDK, Archive and Worker gates. See
[native replacement coverage](native-retirement.md) and
[latest verification status](implementation.md). The counts below describe the
earlier isolation checkpoint; the scaffold inventory is historical, not a second
required application.

`pnpm test:e2e:unity` builds `apps/web` plus a separate two-host fixture beneath
the test build's `/assets/` route. It runs the actual production Node host with
isolated temporary SQLite/blobs, never a live Archive or inherited API process.
The ordinary web build does not include the fixture or expose a testing route.

Twenty-four Chromium workflows cover nine import/editor/assets/first-Save/Restore
flows, eight native viewer/navigation/download flows and seven lifecycle isolation
flows. The two hosts exercise independent workspaces with colliding transport IDs,
reversed reads/saves, focused Ctrl+S, staged uploads/portraits, rooted settings
dialogs, disposal, same-card expected-head conflicts, late AI completions, pending
same-parent fork cancellation, failed-selection Save gating and explicit recovery.
The recovery flow additionally runs with a frozen clock to prove two distinct
snapshots in the same millisecond do not share dismissal identity. Unit seams
cover late token counts, model changes, API auxiliary-read heads, queued recovery
writes and ownership. Screenshots are separately inspected; Playwright interaction
uses real controls rather than evaluating stores to simulate user actions.

Recovery covers saved-card text only. Staged files and unsaved New/Fork drafts
remain memory-only. Deterministic native wizard/tools QA is now included.
Evidence: `runtime/unity-e2e-report` and `runtime/unity-e2e-results`; the final
frozen-clock rerun preserves that full report and uses separate recovery results.

## Earlier scaffold/profile inventory

The browser suite runs production Architect assets with either the built Node
API on the same loopback origin or a separate static-only server with no API. Each API run uses a new temporary SQLite database and blob directory. Each
browser-only test gets a fresh browser context and isolated IndexedDB storage. It never reuses an existing server or accesses legacy/Archive data.
The runner stops only its child process and removes only its own temporary files.

Run `pnpm exec playwright install chromium --only-shell` once, then `pnpm check`.
The retired scaffold used a separate `dist/browser-test` fixture build. Its old
`build:e2e` command is removed; use the native profile scripts above.
CI installs the matching browser and system dependencies. See Playwright's
[web server configuration](https://playwright.dev/docs/test-webserver) and
[browser installation](https://playwright.dev/docs/browsers).

| Requirement / visible claim | Evidence |
|---|---|
| Session, create/select workspace, empty library, import | Browser controls against real local auth/API |
| Two independent drafts | Two mounted editors of the same card; field change in one leaves the other unchanged |
| Core fields | Browser fills basic/character/greetings/advanced forms, tags/arrays and multilingual notes; saved document assertions |
| Embedded lorebooks | Node CCv2, static CCv3 and hub CCv3 workflows edit book settings, primary/secondary keys, content, flags and nested metadata; duplicate IDs target only the selected entry; copy/delete/move, zero/negative numbers, save/export/reload/discard and unchanged originals pass |
| Lorebook instance isolation | Two mounted local editors retain separate entry selection/drafts; failed save retains the edited book for retry; independent controller saves do not affect each other |
| No hidden data loss | Controller and real API assertions retain unknown outer fields, nested extension siblings, lorebooks and opaque values |
| Explicit revision identity | Browser save returns Foundry edit lineage; controller never calls save on open |
| Conflict recovery | Second stale editor gets 409; draft remains until explicit discard |
| Original immutability | Browser downloads accepted original and compares complete bytes after edits |
| Reload persistence | Reload built app, select existing workspace, reopen saved description/name |
| Failed import | Malformed JSON yields an error with no editor created; subsequent valid import succeeds |
| Network failure | Abort save request, assert draft/error, retry successfully |
| Lost session | Remove session cookie, rejected save retains draft, reconnect and save without reload |
| Close/discard decisions | Keep editing and explicit discard paths tested |
| CCv2 and incompatible shapes | Unsupported form fields stay opaque, CCv3-only fields absent on CCv2 |
| Archive selection | Filter/search/empty results, two selected IDs excluding a third, review, import, editor save/reopen and exact-original download in both profiles; fixture snapshot unchanged |
| Browser-only static host | No API requests; import/edit/save with network offline after loading; persisted state after online reload |
| Browser tabs/profile isolation | Independent IDB connections reject stale saves; separate browser context has empty library |
| Storage quota failure | Inject native DOM quota exception during revision add; atomic rollback and retained draft; retry advances to revision 2 |
| Browser PNG/CharX | Real public-SDK fixtures; originals match bytes and edited downloads succeed; a PNG → CharX → import workflow retains opaque descriptors, colliding names, identity and lineage |
| Saved-revision exports | Both Architect profiles download the saved edit while retaining an unsaved draft; hub downloads a second-account fork with root/parent lineage |
| History and comparison | All three hosts compare saved revisions with a draft without replacing it, save from history and preserve originals; native workflow traverses 22 revisions, rejects a stale save, retries failed reads and ignores a cancelled older response; hub recovers a session without losing the draft |
| Asset editor | Three profiles: uploads, raster previews, exact downloads, name/type model, ordering/removal, joint prompt saves, stale second pane, session/network recovery, delayed portrait read cancellation, browser reload, discard and PNG/CharX reimport |
| Layout and responsiveness | Desktop two-pane screenshot, mobile welcome/editor screenshots, viewport-width assertion |
| Hub editor and two real accounts | Built Node account profile and CLI-created keys; first user imports/edits/publishes only selected revisions, second browser forks/edits/publishes, first user lists the child |
| Hub Archive selection | Shared browser filters/reviews exact IDs, imports and edits a selected card, publishes only that card and forks as another real account; source bytes/snapshot stay unchanged |
| Hub Archive recovery | Another import preserves an existing dirty editor; session expiry retains selection for same-account reauthentication |
| Published lineage | Both account publications appear under the same root; fork-source links navigate to the visible parent; SQL/domain tests cover private parents, pagination and revocation |
| Hub ancestor visibility | Making the source private hides published descendants from the second account, while its private workspace copy remains |
| Hub session loss | Logout revokes server session; failed save locks the workbench but retains the draft; same-account sign-in restores and saves it |
| Hub cross-tab accounts | Another tab signs in as a different account; an old tab's create request fails before writing as the new user |
| Hub mobile layout | 390px second-user fork/editor screenshot and no-horizontal-overflow assertion |

Controller tests additionally cover same-document no-op saves, immutable inputs,
invalid field paths/types, nested siblings, host-returned lineage across sequential
saves, and prevention of editing/discard/duplicate save while a save is pending.
Six lorebook controller cases cover unknown book/entry siblings, unsupported
shapes, nested copy independence, explicit null/absence, new IDs, numerical bounds,
list order without insertion-order rewriting and all mutation locks during saves.
The seventeen card-service cases run on both native and emulated IndexedDB adapters;
real browser tests also verify PNG/CharX parsing and persisted asset references.
Export service cases cover content/lineage/asset preservation, corruption and explicit
loss rejection. Asset revisions additionally have native/IndexedDB and real-session HTTP coverage;
five asset controller cases and three browser workflows also cover upload retention,
aliases, reindexing, failures, reload, cancellation and save/discard. These checks do
not prove external-app interoperability;
the separate `verify:sillytavern` command proves actual text-card JSON and a
supported PNG portrait/alias flow with two accounts, unchanged originals and
rejection of external edits and image re-encoding. General external asset transport remains open; see `card-export.md`.

Evidence is generated under ignored `runtime/e2e-results` and
`runtime/e2e-report`. Screenshots receive a separate visual review. The reviewed
390px mobile and 1440px desktop states have no horizontal page overflow, clipped
controls, overlapping panels or missing focus outlines. Long forms intentionally
scroll vertically. Testing in Firefox/WebKit and assistive-technology sessions
remains outstanding; Chromium coverage does not claim cross-browser parity.
