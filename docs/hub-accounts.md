# Hub accounts and sessions

The Node API has two explicit profiles. `local` keeps Architect's loopback,
single-owner session. `hub` uses operator-created accounts and stored, revocable
browser sessions. Both profiles use the same business routes, SQL schema and
Foundry-backed card services. Hub accounts do not inherit the local owner's
workspaces. The account profile has no `/api/local-session` shortcut or public
account-creation route.

## Run the hub locally

From the repository root, build and create two accounts with the operator CLI:

```sh
pnpm bootstrap
pnpm build
pnpm accounts create --name Alice --key-file /tmp/unity-alice-key.json
pnpm accounts create --name Bob --key-file /tmp/unity-bob-key.json
UNITY_PROFILE=hub UNITY_PUBLIC_ORIGIN=http://127.0.0.1:9312 \
  UNITY_WEB_DIR=apps/hub/dist node apps/api/dist/node.js
```

Open `http://127.0.0.1:9312`. Copy the `key` field from the account's JSON file into
the sign-in form. Use separate browser profiles or private windows for separate
users. A new account creates a workspace, imports a JSON/PNG/CharX card, edits it
using the same editor as Architect, reviews selected saved revisions and publishes
them. Another member can fork a visible publication into their own workspace,
edit, save and publish that fork. The UI defaults to members-only visibility,
forks allowed and original downloads off.

Use new key-file paths: the CLI creates files exclusively with mode 0600 and never
overwrites them or prints credentials to stdout. The example `/tmp` paths are
temporary; store real account keys in a suitable private location. The CLI output
contains only account IDs and output paths. Account/key files never belong in Git.

For development with Vite, run the API with
`UNITY_PROFILE=hub UNITY_PUBLIC_ORIGIN=http://127.0.0.1:9311 pnpm dev:api`, then run
`pnpm dev:hub` separately. Vite proxies `/api` to port 9312. The default `pnpm dev`
starts the **local** API profile for standalone Architect; use the explicit hub
profile for hub sign-in. Run one API profile on port 9312 at a time.

## Operator commands

`pnpm accounts --help` lists the commands. A built installation can use
`node apps/api/dist/accounts-cli.js` instead. `--database /absolute/path/unity.db`
or `UNITY_DB_PATH` selects the same Unity database used by the host. Otherwise
both default to `apps/api/runtime/unity.db`. Use absolute paths for explicit
database and key files when invoking through pnpm's package command.

```sh
pnpm accounts list
pnpm accounts rotate --id ACCOUNT_ID --key-file /private/new-key.json
pnpm accounts disable --id ACCOUNT_ID
pnpm accounts enable --id ACCOUNT_ID
```

`list` returns up to 100 accounts without keys or hashes and supplies a `nextAfter`
cursor; pass `--after ID` for the next page. Rotation and disabling revoke all
sessions. Enabling does not restore old sessions. A disabled account's public
content is not automatically removed; content moderation is separate work.
Account IDs and actor URIs are stable across rotation. Accounts default to
`urn:unity:user:…`; `accounts create --actor-uri https://host.example/actors/name`
can explicitly provision a new immutable public identity for signed remote work.
Existing identities cannot be renamed. See [sync sender](sync-sender.md).
If credential creation succeeds but writing its key file fails, the CLI reports
the account ID so it can be rotated to a new writable file.

## Session boundary

Keys and browser session tokens contain independent 256-bit random values. Only
their SHA-256 digests are stored. These are generated credentials, not passwords
chosen by users. Keys are submitted only to `POST /api/session`; a successful
login issues a fresh session and revokes the cookie it replaces. The response
body contains the public actor, display name and absolute expiry, never a token.
`GET /api/session` checks the current session; `DELETE /api/session` revokes it.

Sessions expire after 30 minutes idle or eight hours absolute, whichever comes
first. The server checks both limits; browser cookie expiration alone is not an
authorization check. Each account retains at most eight sessions. Successful
requests update activity without extending absolute expiry. Logout, key rotation
and disabling invalidate stored sessions. Expired records are cleaned during a
new login and remain bounded by the per-account session cap.

Cookies are HttpOnly and SameSite=Strict. An HTTPS origin uses the `__Host-`
prefix, Secure and Path=/, without Domain. Loopback HTTP uses a separate cookie
name with Path=/api. The explicit `UNITY_PUBLIC_ORIGIN` governs host/origin checks
and cookie policy; forwarded headers cannot change them. Mutations require the
exact browser Origin, and cross-site Fetch Metadata is rejected. The Node listener
defaults to loopback; only the hub profile permits `HOST=0.0.0.0` or `HOST=::` for
containers. The supplied Compose file publishes the hub to host loopback. A local
HTTPS proxy rehearsal verifies cookie attributes, canonical Host/Origin checks,
account revocation and persistent sessions through container replacement; see
[containers](containers.md). Public HTTPS ingress is not provisioned here.

The hub client sends `X-Unity-Actor` with the account it expects. A mismatch with
the authenticated cookie returns `ACCOUNT_CHANGED` (409) before a domain action
or logout. This prevents an old tab from silently creating content as a different
account after another tab signs in. The header never grants authentication.
An expired or changed session locks the workbench while retaining its draft;
same-account sign-in recovers it. Explicit logout asks before discarding a dirty
draft. Drafts are still memory-only and will not survive a page/browser crash.

Every authenticated request receives a store driver bound to its verified session.
The driver checks the session in the same atomic SQL batch as each domain write.
Revocation while an import or fork copies bytes prevents its subsequent card
commit. Transient guard rows are removed within that batch; failures roll them
back. Copies already staged before revocation may need the future blob garbage
collector. Bytes already delivered and already committed work cannot be recalled.

Node login has a bounded per-process limit of 60 attempts per minute, independent of
untrusted IP headers. This is an initial admission limit, not a distributed ingress
rate limiter. Cookie/token handling follows the principles in the
[OWASP session guide](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [MDN cookie reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

## Evidence and remaining gates

SQL migration 4 appends accounts, sessions and write guards without changing prior
migrations or card ownership. Six requirements run on SQLite and local D1 and
generate `runtime/accounts-conformance.md`. HTTP tests use real keys/sessions and
exercise two-account publication/fork, revocation, in-flight import rollback,
cross-origin rejection, cookie rules, stale tabs and the actual operator CLI.

Eight Chromium workflows use the built Node host and CLI-created accounts, with
no test login endpoint: selected publication and a second-browser fork, session
recovery with draft preservation, cross-tab account changes, Archive selection
through a second-account fork, Archive selection recovery after expiry, and
embedded lorebook editing with save/export/reload and unchanged accepted originals,
revision comparison with draft-preserving session recovery, and asset editing.
Published lineage links are exercised after the second account publishes. Desktop and
mobile layouts are covered. No production accounts or remote services are used.

The hub now mounts the shared editor and supports file import, saved-revision
selection/review, shared Archive browsing, published lineage across revisions and
forks, and making a publication private. Configure `UNITY_ARCHIVE_ORIGIN` on the
API as described in [Archive import](archive-import.md).

The [local Worker profile](worker-profile.md) now uses the same account API over
D1/R2, with a platform login-rate binding and operator commands for local state.
Its separate real-Wrangler browser rehearsal proves two-account publication/fork
and restart persistence. External-instance discovery, richer publication management,
general asset transport and remote Worker hosting/production ingress remain open.
