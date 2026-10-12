# Local Worker account profile

The Workers entrypoint now mounts the shared account, workspace, card, asset and
publication API using D1 and R2. It runs the same domain composition as Node.
All bindings and session-scoped services are created within the request; there
is no shared mutable account, driver, request or response state.

This profile has been exercised in local workerd and through the actual Wrangler
CLI with the built hub and two independent Chromium sessions. No Cloudflare
account, remote resource, production origin or deployment has been configured.
The checked-in database ID is a local placeholder, not a provisioned database.

## Run locally

From the repository root, after bootstrap and installing Chromium for verification:

```sh
pnpm build
mkdir -p runtime
pnpm accounts migrate --worker-state "$PWD/runtime/worker-state"
pnpm accounts create --name Alice --key-file "$PWD/runtime/worker-alice.json" --worker-state "$PWD/runtime/worker-state"
pnpm dev:worker --persist-to "$PWD/runtime/worker-state" --assets ../hub/dist
```

Open `http://127.0.0.1:9312`. Use the `key` value from the private account file to
sign in. The hub and API share this origin; the separate Vite hub development
server is not needed. Node and Worker use port 9312 by default, so run one at a
time. `--assets ../hub/dist` is relative to the API package, where Wrangler runs.
Without that option, the Worker serves only the API.

`--worker-state` and Wrangler's `--persist-to` must identify the same absolute
local directory. The operator opens its `v3` persistence root using Wrangler's
`getPlatformProxy` with remote bindings explicitly disabled. The default native
Unity database and blob directories are independent. Neither profile discovers
Archive paths or uses Archive's database.

The existing `accounts list`, `rotate`, `disable` and `enable` commands accept
`--worker-state` instead of `--database`. Key files remain exclusive mode 0600
and keys are never printed. A `--database` and `--worker-state` combination is
rejected. Stop local dev while running operator migrations/account commands;
they inspect/apply the shared migration ledger before account operations.
There is no public bootstrap, account creation, migration or local-session route.
The Worker operator commands require the development workspace's Wrangler
installation; the Node runtime container does not include Wrangler.

The [peer operator commands](peer-operators.md) also accept `--worker-state` for
local D1 grants, public-key inspection, atomic rotation, revocation and nonce
cleanup. Key generation is local file work and needs no database binding.

For another port, set both `--port` and
`--var UNITY_PUBLIC_ORIGIN:http://127.0.0.1:PORT` when starting local Wrangler.
The canonical origin includes the scheme and port and must exactly match the
browser's address. Forwarded headers do not select it.

## Request and storage behavior

`/api/health` reports process health. Every other API request checks the configured
origin and current checksummed schema. An absent, older or altered schema fails
closed with 503; an HTTP request never creates tables, migrates or repairs data.
`/api/ready` is successful only after operator initialization. Unknown API paths
remain JSON rather than returning the static application's HTML.

D1 queries use the primary database directly. Read replicas and client-supplied
session bookmarks are not enabled. This keeps authorization and publication
policy reads on the primary. Domain writes retain the existing atomic SQL session
guards, expected-head checks and publication-access guards. R2 uses the existing
verified immutable blob adapter and Workers' `FixedLengthStream`; card parsing,
identity, lineage and export still come from the external Foundry SDK.

The same canonical-origin, cookie, account-change and revocation checks used by
the Node account host apply. In addition, the Worker rejects requests whose URL
scheme differs from the configured origin; it does not need Node's allowance for
TLS termination at a local reverse proxy. HTTPS origins use `__Host-` Secure,
HttpOnly, SameSite=Strict cookies. The loopback HTTP profile uses its existing
local cookie name/path.

Login admission uses the `UNITY_LOGIN_LIMITER` binding: 60 attempts per 60 seconds
for the configured origin, independent of caller-supplied IP or account headers.
It is checked before parsing credentials and persists across individual request
compositions. Binding errors fail closed. This is Cloudflare's location-scoped,
eventually consistent admission limit, not a global strict quota or a production
abuse-control claim. A deployment must choose an appropriate unique namespace.
See the [rate-limit binding contract](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
and [D1 primary/session behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Archive reads and imports

`UNITY_ARCHIVE_ORIGIN` is an optional, operator-selected read-service origin.
Its checked-in value is empty, which leaves Archive routes unavailable. To use
the local fixture service, start it in a separate terminal:

```sh
UNITY_ARCHIVE_MODE=fixture pnpm dev:archive
```

Then start the already initialized local Worker with that source:

```sh
pnpm dev:worker --persist-to "$PWD/runtime/worker-state" --assets ../hub/dist \
  --var UNITY_ARCHIVE_ORIGIN:http://127.0.0.1:9313
```

For indexed search, run Archive in its explicitly prepared
[copy profile](archive-copied-source.md) instead. The built hub's **Browse Archive**
uses the same metadata, lexical, filter-only, numeric/date, semantic and hybrid
contracts as the Node hub. Modes depend on source capabilities. Embeddings and
Lance queries execute in the separate Archive service. Neither native modules
nor database paths enter the Worker bundle, and the browser uses same-origin
Worker routes; it needs no direct Archive CORS access.

The configured URL must be an exact HTTPS origin without credentials, path,
query, fragment or trailing slash. HTTP is allowed only when both the Worker
public origin and Archive origin are loopback HTTP addresses. A hosted Worker
requires an independently reachable HTTPS Archive read service; its loopback is
not the operator's machine. Configuring this variable does not expose, tunnel,
deploy or provision that service. An invalid value returns 503 for service
requests, while process health remains available.

Clients cannot supply source URLs or credentials. Outbound reads contain no
incoming cookie, access key or account header. The client uses manual redirect
handling and rejects redirect/opaque-redirect responses without contacting the
destination; workerd rejects the Fetch `redirect: "error"` option. Workspace
authorization occurs before and after reads, and session-guarded D1 commits
reject imports if authority changes during downloads. A configured source is
available to authorized workspace owners on this hub; per-account source
selection and source-service credentials are not implemented.

The Worker limits each import selection to **8 MiB** of declared original and
available-asset bytes, checked before any object download. The Node/browser
default remains 64 MiB. Every byte still passes the shared digest/length checks
before import, with original bytes retained in R2. This reduces admitted input
size; it is not a production memory guarantee for large compressed containers,
parsed documents or concurrent requests. An unavailable source or invalid
response is an explicit failure, never a switch to another source/search mode.

Configuration uses request-scoped bindings and generated Env types, following
[Cloudflare's environment variable contract](https://developers.cloudflare.com/workers/configuration/environment-variables/).
The import limit reflects the need for bounded buffering described in
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Signed publication reads

`UNITY_SYNC_ENABLED` defaults to `"false"`. Setting it to `"true"` enables the
[read v1 routes](sync-foundation.md#opt-in-publication-reads) for explicitly
provisioned peers with `pull` scope. An exact HTTPS public origin and the
`UNITY_SYNC_LIMITER` binding are required. The binding uses a separate namespace
(`1002` in the local config), 120 attempts per 60 seconds and an origin-wide key;
choose deployment namespaces explicitly. It has the same platform consistency
and location limits as the login binding. Cookies do not authorize these reads.
Set `UNITY_SYNC_WRITES_ENABLED="true"` as a separate opt-in for signed publish/fork
commands over host-resident revisions. It requires signed reads to be enabled.
The same write opt-in accepts signed remote-fork bundles, bounded to 8 MiB, with
verified parent/author ancestry and exact assets. Near-limit bundle tests run on
actual D1/R2. The account CLI accepts an explicit immutable HTTPS `--actor-uri`
for new public identities on local D1. The optional secret binding
`UNITY_REMOTE_CONNECTIONS_JSON` enables the shared account-scoped sender routes
and hub controls. It contains operator-selected account/destination/key records;
no private keys go in public vars or browser requests. See [connected hubs](remote-hubs.md).
Remote peer provisioning remains separate.

## Evidence and remaining gates

Seven account/Archive Vitest cases execute the actual bundled Worker in workerd
with D1 and R2; a separate configuration case checks accepted origins:

- Empty/altered schemas and invalid origins fail without HTTP migration or repair.
- Two real account sessions import exact originals, save an attachment and edit,
  reject a stale save, publish one selected revision, fork as the second account,
  export/reimport CharX and retain bytes/sessions through process replacement.
- Origin/scheme/account mismatches and local-session shortcuts fail; the rate
  binding limits sign-in across separate requests; disabling an account revokes it.
- The actual operator CLI migrates and creates protected key files in local D1;
  the Worker consumes the same persistent database, and CLI disabling revokes
  its session. Existing key files cannot be overwritten by rotation.
- An explicit copied SQLite/Lance source supplies filtered, ordered and paged
  lexical reads, semantic/hybrid reads, selection and exact R2 imports. A harness
  bridges outbound HTTPS requests to the real native read adapter and checks
  that account credentials never leave the Worker. Imports survive restart.
- Oversized selections fail before downloads; corrupted originals and redirects
  fail without card/R2 writes or requests to the redirect destination.
- Revocation during metadata, lexical, semantic and selection reads prevents
  their return; revocation during import prevents the D1 commit. Complete copied
  file inventories, including source queues, remain unchanged.

Twelve additional signed-sync cases execute the real SDK client against bundled
workerd D1/R2, including assets, visibility, revocation, tamper, replay, signed
publication/fork commands, lost responses, concurrent receipt recovery and
enriched fork submission with corrupted/false-attribution rejection, a separate
persisted sender using this Worker as receiver, lost outbox acknowledgments across
sender restart/key rotation, configured HTTP isolation and failed-pull checks.
The outbox store separately passes six requirements on local D1. The suite also
executes the sender itself inside workerd against both receiver adapters, with a
secret connection, outbound SDK requests, D1/R2 persistence and receipt recovery
after process replacement. Its
outbound traffic uses a harness bridge; deployed networking is not established.

`pnpm verify:worker` separately starts the actual Wrangler CLI with a temporary
state root and built hub assets. Two independent Chromium sessions complete
import → edit → publication → fork → edit and recover saved data and sessions
after restarting Wrangler. It also starts a separate Node copied-Archive service
and exercises real Worker-to-Archive HTTP, filtered/ordered UI search, reviewed
imports, preservation of unsaved drafts, exact originals in R2 after restart and
unchanged copied SQLite/Lance/queue bytes. These browser requests go through the
Worker, with no direct browser-to-Archive request or test fetch bridge. It checks
unchanged original bytes and no browser errors. It stops only its own processes and removes its own temporary account
files/state. Its non-secret report is `runtime/worker-rehearsal.json`.
Both sets of checks run in `pnpm check`; the Worker production bundle is also
built with a local dry run. No remote calls or credentials are needed.

Remote resource provisioning, operator tooling for remote D1, ingress/TLS setup,
remote D1/R2 validation, platform CPU/memory limits under large imports and
concurrency, backups, rate-limit tuning and blob garbage collection remain
unproven. Local workerd results do not establish production deployment readiness.
