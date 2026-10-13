# Architecture decisions

## Owner correction, 2026-10-13

One application: Archive is the local ingestion/history/search foundation; Unity
provides presentation, editing, forks and sharing. Keep the existing Archive
`cards.db`, files and LanceDB. New scrapers write to that same database using the
existing schema and source deduplication; necessary versioned additions stay
there. Unity keeps its own workspace database. Favorites link archived originals
into the library, and saved edits create forks. Viewing and favoriting do not copy
originals or unchanged assets. File import must check Archive and Unity before
creating another entry.

Complete the Archive foundation before further viewer/editor work. The current
native store is a separate-schema prototype, not an approved additional corpus.
There is no measured evidence that rebuilding the existing database improves
efficiency. Implementation and operational acceptance are tracked separately in
[`implementation.md`](implementation.md). See the
[accepted decision](adr/0001-existing-archive-and-library-references.md) and
[owner direction](../../1013_archive_foundation.md); they supersede conflicting
scaffold-era descriptions below.

Accepted direction, 2026-10-11: scaffold a new `character-unity` repository using
Vite/React + Hono. Foundry remains primitives; Archive owns its separate database
and search stack. The scaffold now has store, asset, Archive-read and initial card
workflow foundations; the complete editor/publish/fork slice remains in progress.

## Data and runtime ownership

```text
Architect browser ──┐
                    ├── shared API ── shared workspace/revision store
Hub browser ────────┘       │
                           └── Archive read client (fixture contract implemented)
                                      │
                            Archive local service
                                      │
                           Archive DB / files / LanceDB

Foundry SDK supplies format and protocol primitives to relevant consumers.
Static Architect uses the same card/asset services with IndexedDB persistence
instead of the API. Its separate build has no API calls or Node dependencies.
```

`apps/api` is the execution host, `packages/api` the shared implementation. Hono's
Fetch interface keeps business routes independent of the Node adapter. A separate
Workers entrypoint composes the same account/domain services over local D1 and R2.
Its operator migration, accounts and built-hub workflow are verified in local
workerd; remote bindings and hosting remain unconfigured. Node has separate
local-owner and account-session profiles with the same business API. Archive is Node-only and is not bundled into that Worker.

Archive remains the only writer to archived originals and metadata. Its read API
must not trigger refresh/sync, mutation, repair or asset downloads. Stable subset
manifests and exact original bytes are implemented against an opt-in immutable
fixture or explicit copied-SQLite source; the default host has no source configured. No live Archive adapter
is installed. See `archive-read-contract.md` for snapshot and read semantics.
The shared store handles edits, immutable revisions, forks and pinned hub
publications with versioned access policies. Mutations use atomic statement batches and SQL guards,
not the old Federation async transaction wrapper. Native SQLite and local D1
share the same contract tests. See `packages/store/README.md` for trust boundaries.
The separate [Archive native image](archive-native-runtime.md) includes its
locked SQLite/LanceDB/Arrow stack. Installation, synthetic search and read-only
reopen checks pass on Linux amd64. The read service now exposes optional lexical
and Boolean search over an explicit pinned copied index; metadata list queries
retain substring semantics. Advanced filters, vector/hybrid search and full
production parity remain staged.

## Foundry is external

Keep container parsing/writing, schema primitives, canonical identity and protocol
primitives in the SDK repository. Add versioned APIs without reinterpreting existing
public hashes. App auth, database drivers, moderation and deployment belong here.
Do not add SDK dependencies until there is a real consumer, and do not copy a local
SDK tree or unresolved `workspace:` dependency into released packages.

## UI and editor

Vite/React is the accepted hub direction. Architect now consumes the per-instance
editor package and injects saves through the shared API. Hub mounts that same
editor with account sessions, publication, forks and visible lineage browsing.
Core fields and embedded lorebooks are editable; remaining rich features need staged ports,
with their status recorded in `editor-port.md`. Archive's existing UI can be
ported separately without coupling data adoption to a framework rewrite.

## Already settled historical decisions

- CardsHub starts fresh, without old users or database migration.
- Existing downscaled Archive bytes are accepted as the new adoption baseline;
  do not re-fetch them. New original-byte guarantees start at adoption.
- New Archive omits the PNG optimizer queue and triggers. The live Archive stays
  untouched until a separately scheduled, rehearsed adoption.

## Contracts still to specify

The user's scaffold approval does not settle public wire details. Before the
relevant feature lands, specify canonical hash vectors, lineage namespace/schema,
asset identity, format-loss policy, authenticated publish/fork behavior, editor
ports and the live Archive adapter's snapshot retention. Operator-created accounts
are implemented. Signed HTTP sync now has an unreleased Foundry transport profile;
durable peer/key grants and replay admission are implemented on SQLite/D1. Atomic
publish/fork receipts and commit-time guards now share the domain SQL batches.
Local peer operator commands are implemented; blob cleanup, remote provisioning
remain open. Shared signed endpoints, account-bound sender routes and durable
return review/retry controls are implemented on the current development SDK pin.
See [connected hubs](remote-hubs.md) and
[signed sync foundation](sync-foundation.md).

## Provenance

Inputs were the workspace's `1010_unification_plan.md`, `AUDIT_GLM_2026-10-10.md`,
`audit-work/SOL/report-body.md` and `1011_unification_design.md`. Large audit reports
and snapshot directories are not copied into this repository.

| Source | Audit baseline |
|---|---|
| Architect | `ceb138e769470f104851f34869c1fb058c50d11b` |
| Archive | `b99dcd1201f136fcbf71b4e8f1f3ec2d217c57b0` |
| Federation | `37a81e3af0fad53e60a1d634d55de49d7d3cbe8c` |
| Foundry | `1209ac4fc159cc981bd7c7c2ea20c641cbd956f9` |

These identify audited source, not instructions to discard later fixes or dirty
working-tree changes. Select the actual port baseline explicitly for each feature.

Scaffold implementation references:
[Hono Node adapter](https://hono.dev/docs/getting-started/nodejs),
[Vite](https://vite.dev/guide/),
[pnpm workspace settings](https://pnpm.io/settings),
[Workers configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
