# Archive selection UI

One per-instance search, selection, manifest review and import panel for Architect
and the hub. The host supplies an `ArchiveHost`, workspace ID, busy/error hooks
and a completion callback. This package owns no account, API origin, persistence,
editor state or Archive database access.

`createArchiveHttpHost(request)` adapts an injected authenticated JSON transport
to the shared workspace Archive routes. It sends only snapshot tokens and exact
IDs, not entire pages/manifests. Browser-only Architect instead injects its direct
read client and IndexedDB-backed importer. Import `styles.css` in each host.

Only one operation runs per panel. Unmount aborts its request. Completed imports
are removed from the selection before the host callback runs, so a failed library
refresh does not suggest blindly repeating completed writes. A partial import
shows completed items and requires a new review for the remaining selection.
Hosts decide whether to open an imported card; the hub preserves any open draft.
