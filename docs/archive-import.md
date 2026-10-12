# Archive selection import

Architect and hub import copies from the configured Archive read source.
`packages/archive-browser` supplies their common search, selection and review UI;
each host injects transport, authentication and import-completion behavior. Archive keeps
ownership of its DB/search/files and receives only GET requests. This implementation
supports synthetic fixtures and an explicitly prepared, read-only SQLite copy.
An optional copied Lance index enables the shared browser's **Card text** mode
with Boolean/phrase search, paging and relevance/title order; see
[Archive search](archive-search.md). Metadata browsing remains available without it.
Validation uses synthetic data; no live Archive connection or data migration is implied.

## Run locally

Start the independent fixture service:

```sh
UNITY_ARCHIVE_MODE=fixture UNITY_ARCHIVE_READ_ORIGINS=http://127.0.0.1:9310 pnpm dev:archive
```

For an isolated copied database and files, use the manifest and startup instructions
in [Copied Archive read source](archive-copied-source.md). Both modes expose the
same read contract and use the client configuration below.

For the local API profile, in another terminal:

```sh
UNITY_ARCHIVE_ORIGIN=http://127.0.0.1:9313 pnpm dev
```

For browser-only storage instead:

```sh
VITE_UNITY_ARCHIVE_ORIGIN=http://127.0.0.1:9313 pnpm dev:browser
```

The two web profiles share port 9310; run one at a time. For a static build,
set `VITE_UNITY_ARCHIVE_ORIGIN` when running `pnpm build:browser`, and allow the
actual static site's exact origin on Archive. The default static build has no
Archive source. Configuration is explicit: failed API access never switches
storage or discovers live Archive files. Read CORS is opt-in, not account auth.

For the hub, start the account API with `UNITY_ARCHIVE_ORIGIN` as well:

```sh
UNITY_PROFILE=hub UNITY_PUBLIC_ORIGIN=http://127.0.0.1:9311 \
  UNITY_ARCHIVE_ORIGIN=http://127.0.0.1:9313 pnpm dev:api
pnpm dev:hub
```

Create accounts using [hub setup](hub-accounts.md). Server-side Archive reads
need no browser CORS grant. The hub preserves an existing editor draft when
imports complete; open an imported card from the library when ready.

Create/select a workspace, choose **Browse Archive**, search/filter, check the
cards to copy, then review and import the selected originals. Successful imports
appear in the library; the hub opens the first only when no editor is already open. Original download remains
the exact source file even after saving revisions.

## Contract and guarantees

- The host fixes the read origin. Requests carry a workspace, contract/snapshot and
  exact IDs; never an arbitrary URL, filesystem path or owner ID.
- Authorization precedes Archive reads. The client checks snapshot identity,
  manifest membership, byte lengths and SHA-256. Redirects and credentials are
  disabled. Source URLs are provenance only.
- A selection contains 1–100 unique IDs. Its declared originals plus available
  assets must fit 64 MiB; individual objects retain the read contract's 32 MiB cap.
- All selected bytes and portable card forms are verified before any card is
  created. Source parsing, identity and lineage come from the external Foundry SDK.
- Existing assets outside the original require an explicit portrait or exact URI
  binding. They must fit the card import's 32 MiB supplied-asset bound. Conflicting,
  duplicate or unused bindings fail. An unbound available asset is accepted only
  when the same bytes are already embedded and preserved by the container parser.
- Missing optional assets are recorded as unavailable. A missing asset required by
  a declared URI prevents import. No downloader or repair job fills the gap.
- Each card records immutable Archive ID, card ID, snapshot, original digest,
  source provider/record/URL and unavailable asset IDs. Actual revision assets have
  verified bytes/digests in Unity's own store. Opening/importing invents no lineage;
  subsequent edits use the ordinary revision service.
- A 25-second deadline limits admission/preflight and stops starting additional
  cards. An in-flight per-card storage operation can finish after that deadline.

## Batch failures and retries

Card/source/revision writes are atomic per card, not across the whole selection.
Validation failures before writes leave no imported cards. If storage fails later,
the importer stops and reports exact completed cards, the failed ID and interrupted
status. The UI removes completed IDs from the selection and requires another
review of the remainder. It never silently retries a failed request.

No persistent import-job/idempotency key exists yet. Deliberately importing the
same selection again creates more copies. If the response is lost or the browser
closes mid-import, refresh and inspect the library/source provenance before retrying;
a completed write may have outlived the request. Durable import jobs/deduplication
remain operational work. Staged/unreferenced blobs follow the existing asset
service's cleanup limitations.

## API

All routes require the host session and live under
`/api/workspaces/:workspaceId/archive`:

| Route | Input | Result |
|---|---|---|
| `GET /cards` | `q`, `provider`, `tag`, `snapshot`, `cursor`, `limit` | Verified metadata page |
| `POST /selection` | `{snapshot, ids}` | Exact selection manifest |
| `POST /imports` | `{snapshot, ids}` | Manifest, completed imports, failures, interrupted flag |

`Snapshot` contains `version`, `archiveId` and `snapshot` digest. The import route
re-reads its exact manifest instead of trusting client-provided card descriptors.
An unconfigured source returns 503; invalid input is 400, stale snapshot 409 and
oversized selection 413. Unexpected internal errors omit exception details.

The browser host calls the same importer directly over its IndexedDB-backed card
service. The read client uses CORS only for explicitly configured Archive origins.

## Validation

Integration tests cover exact subsets, separately stored asset bytes, immutable
originals/source snapshots, preserved opaque fields through edits, unauthorized
reads, stale/invalid selection, corrupt assets, limits/cancellation, partial storage
failure and read CORS on both JSON and byte responses. A copied-source integration
case also checks that importing and editing preserve the copied database and files.
Status, search, list and selection reads recheck workspace/account-session access after
the remote response; revocation during a read withholds its result.
Chromium exercises the
full search → review → copy → edit/save → reload → exact-original workflow on both
storage profiles, excluding an unselected card. Hub browser tests also take a
selected Archive card through an edit, exact publication selection and a real
second-account fork, verify unchanged originals, preserve an existing draft
during another import and recover selections after session expiry. These checks
do not prove live Archive search parity or the SillyTavern round trip.
