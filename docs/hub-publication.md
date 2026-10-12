# Hub publication foundation

The shared API supports selected-revision publication, policy changes,
publication reads, original/asset downloads and forks into an owned workspace.
`packages/cards/hub` uses Foundry's public identity and sanitization primitives;
`packages/store/hub` supplies the SQLite/D1 repository. Schema migration 3 appends
publication snapshots, immutable fork relations and bounded ancestor relations.
Existing revisions, sources and migration checksums remain unchanged.

The hub web app now signs in real operator-created accounts, imports/edits private
cards, reviews selected revisions, publishes and forks using the shared editor.
Every hub HTTP route still requires a session. The Node host offers either its
local single-owner profile or an explicit account profile, with expiring/revocable
sessions and an account-key CLI. See [accounts and setup](hub-accounts.md). Anonymous
public hosting, signup and remote deployment remain unimplemented.

## Publication behavior

Select 1–20 explicit revision IDs from one owned workspace and supply a policy.
The complete selection commits in one SQL batch or rolls back. Each document is
limited to 256 KiB and the selection to 1 MiB. A revision can be published once
per owner; repeating the request is not an idempotent success. After a lost
response, inspect the publication list before submitting another selection.

Publication pins the selected revision, including its sealed asset manifest.
Future workspace saves do not change the publication. An older revision may be
selected explicitly. Foundry removes `charx_media` and `foundry.local`, retains
unknown public data and verifies content identity and any existing lineage.
Publication does not add lineage to an untouched import. Sanitization is a
defined field policy, not a general secret detector or content moderation pass.

Initial policy values are `private`, `members` and `public`, plus separate
`allowOriginal` and `allowFork` booleans. The caller must supply all three fields;
the UI defaults original downloads off. Owners can download their
own source and fork their own publication, subject to ancestor restrictions.
Policy updates require the expected version, preventing silent overwrites.
These are initial implementation choices, not a permanent product policy.

Public service representations contain the sanitized card, public identity,
root hash, owner ID, parent publication ID, policy and portable asset descriptors.
They exclude workspace IDs, private revision IDs, source provenance and storage
keys. Lists contain at most 20 entries and paginate by publication ID; an optional
parent ID lists direct published children. The lineage endpoint additionally pages
all visible publications sharing an original, including separate revisions and
fork branches. It derives the root from a visible anchor publication, applies
ancestor permissions before pagination and rechecks visibility after assembly.
Migration 5 indexes this root lookup.

The hub renders these nodes with content/revision hashes, revision-parent links
and exact local fork-source links. Unpublished or inaccessible parent hashes stay
opaque; no private history is loaded to fill gaps. External instances are not
crawled. Pages are a live view, not a snapshot: refresh after publication or policy
changes. Reading this graph never creates lineage.

## Forks, bytes and access changes

Forks require an authenticated actor, an owned target workspace and current
permission on the publication and every ancestor. Referenced assets are copied
to the target workspace and rehashed before completion, with a 64 MiB aggregate
limit. No remote asset URLs are fetched. Foundry writes a fresh fork revision
with the public actor URI, nonce, root hash and the existing lineage as parent.

A fork's accepted source is the sanitized published JSON snapshot. It is **not**
the ancestor's original file. Downloading the fork's accepted source therefore
does not bypass the ancestor's original-download permission. The lineage root
still identifies the ancestor's original bytes. If `allowOriginal` is explicitly
enabled on a publication, its exact accepted source file is downloadable and can
contain fields excluded from the sanitized publication. Review that file before
granting this permission.

The final fork SQL batch rechecks the selected publication's policy version,
all ancestor visibility/fork permissions, target ownership and source revision.
A policy change during asset copying rejects and rolls back the card, revision,
source relation and fork relation. Already staged/copied orphan blobs need the
future garbage collector; they are not exposed by public publication routes.

Making an ancestor private hides its published descendants from other accounts,
including their documents, downloads and fork operations. Disabling ancestor
fork permission prevents new descendant forks. Existing private workspace copies
remain with their owners, and previously delivered bytes cannot be recalled.
Ancestry is limited to 32 fork edges. The owner can still update a hidden child's
policy by ID; a separate owner-management listing remains to build.

## Shared HTTP routes

All current routes require the host session and return `Cache-Control: no-store`.
The local host also applies its existing Origin and Fetch Metadata checks.

| Method | Route under `/api/hub` | Body or query |
|---|---|---|
| POST | `/publications` | `{workspaceId, revisionIds, policy}` |
| GET | `/publications` | Optional `afterId`, `limit` (1–20), `parentId` |
| GET | `/publications/:id` | Sanitized pinned publication |
| GET | `/publications/:id/lineage` | Visible root graph; optional `afterId`, `limit` (1–20) |
| PATCH | `/publications/:id/policy` | `{expectedVersion, policy}` |
| POST | `/publications/:id/forks` | `{workspaceId}` |
| GET | `/publications/:id/original` | Exact accepted source, if permitted |
| GET | `/publications/:id/asset?path=declared%2F0` | Published logical asset path |

Invisible publications and unavailable downloads return 404. Missing sessions
return 401, foreign workspaces 403, and stale policies 409. Request bodies are
bounded and cannot specify the author, source storage key or a remote fetch URL.
Downloads are attachments with `nosniff`, a restrictive CSP and no caching.

## Verification and remaining work

Five SQL requirements run on both SQLite and actual local D1. They cover exact
selection, rollback, immutable snapshots, policy versions, ownership and ancestor
restrictions, plus root pagination without hidden-row cursors; `pnpm test` generates `runtime/hub-conformance.md`.
Eight domain tests use the external Foundry SDK and real filesystem bytes to cover
sanitization, identity, two-actor forks, asset copying, corruption, permission
races, unchanged originals and lineage views without private-parent enrichment. Three HTTP tests cover routes, input validation,
private-source isolation and the local browser/session boundary.

Accounts/session revocation, the shared editor in the hub and publication review
are now implemented, alongside shared Archive browsing and visible published
lineage across revisions/forks. Owners can download verified saved revisions from
the editor, including their forks. See [export limits](card-export.md).
The actual two-account SillyTavern JSON flow passes with fixture Archive data and
unchanged identity/originals. Asset-bearing external formats, live Archive adoption
and remote/Workers hosting remain outstanding. The Node container now has a local
HTTPS, two-account publication/fork and persistence rehearsal; see [containers](containers.md).
The Archive service and its database/search ownership are unaffected.
