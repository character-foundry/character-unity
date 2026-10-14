# Hub accounts and sessions

The Node API has two explicit profiles. `local` keeps Unity's loopback,
single-owner session. `hub` uses operator-created accounts and stored, revocable
browser sessions. Both profiles use the same business routes, SQL schema and
Foundry-backed card services. Hub accounts do not inherit the local owner's
workspaces. The account profile has no `/api/local-session` shortcut or public
account-creation route.

Both profiles serve the active `apps/web` application: library, Archive, viewer,
native Architect editor, Sharing and Connected hubs. The earlier `apps/hub` host
is retired; the native account UI is the only account application.

## Run the hub locally

From the repository root, build and create two accounts with the operator CLI:

```sh
pnpm bootstrap
pnpm build
pnpm accounts create --name Alice --key-file /tmp/unity-alice-key.json
pnpm accounts create --name Bob --key-file /tmp/unity-bob-key.json
UNITY_PROFILE=hub UNITY_PUBLIC_ORIGIN=http://127.0.0.1:9312 \
  UNITY_WEB_DIR=apps/web/dist node apps/api/dist/node.js
```

Open `http://127.0.0.1:9312`. Copy the `key` field from the account's JSON file into
the sign-in form. Use separate browser profiles or private windows for separate
users. The native app opens a workspace for the account; its account menu selects
or creates others. Import a JSON/PNG/CharX card, edit it, then use Sharing to
review selected saved revisions before publishing. Another member can fork a
visible publication into their own workspace, edit, save and publish that fork.
The UI defaults to members-only visibility, forks allowed and original downloads off.

Use new key-file paths: the CLI creates files exclusively with mode 0600 and never
overwrites them or prints credentials to stdout. The example `/tmp` paths are
temporary; store real account keys in a suitable private location. The CLI output
contains only account IDs and output paths. Account/key files never belong in Git.

For native development with Vite, run
`UNITY_PROFILE=hub UNITY_PUBLIC_ORIGIN=http://127.0.0.1:9312 pnpm dev`, then open
`http://127.0.0.1:9430`. Its development proxy rewrites API Host/Origin to the
configured API target, port 9312 by default. The ordinary `pnpm dev` command uses
the local owner profile; the explicit environment selects account sign-in for the
same web app. Run one API profile on port 9312 at a time. For deployment, use the
same-origin built host or a separately configured canonical-origin proxy; the
development proxy is not public-ingress configuration.

## Native sharing workflow

Open **Sharing** in the native navigation. Select 1–20 saved owned revisions and
review their content before publishing. **Choose revision** opens paginated
history so a historical revision can be selected instead of the current head.
Refreshing the library or saving a newer head does not replace the pinned
selection. Unsaved editor changes are never included.

Publication detail supports private/member/public visibility, fork permission
and original-download permission through version-checked policy updates. Members
can fork permitted visible publications into their private workspace and open
them in the native editor. **Published lineage** shows only visible publications
and parent links; unpublished or inaccessible history stays opaque. Original
downloads require the publication's permission, except for its owner.

Archive references are read-only links, not owned Unity revisions. They are
disabled in publication selection and cannot be prepared for remote return.
Save a changed fork to obtain an owned revision first. An unchanged Save creates
no copy and does not make a reference publishable. See [Connected hubs](remote-hubs.md)
for configured peer pulls and reviewed durable returns.

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

`GET /api/client` explicitly declares the profile and browser capabilities. The
native browser does not infer a local profile by trying account login and then
falling back to a local-owner session. Hub capabilities disable browser LLM
credential loading and direct provider requests; the local installation keeps
that opt-in editor feature.

The native session/library clients capture their authenticated actor and workspace.
JSON requests, protected media and binary downloads send `X-Unity-Actor` with the
account they expect. A mismatch with
the authenticated cookie returns `ACCOUNT_CHANGED` (409) before a domain action
or logout. This prevents an old tab from silently creating content as a different
account after another tab signs in. The header never grants authentication.
An expired or changed session locks the workbench while retaining its draft;
same-account sign-in recovers it. Deliberate logout/account switching asks before
disposing the previous account's clients and open editors. Workspace changes do
not retarget an existing client or pending operation. Saved-card text recovery is
scoped to actor, workspace, card and draft owner; staged files and unsaved New/Fork
drafts remain memory-only. See [editor lifecycle and recovery limits](editor-port.md).

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

Final validation of the current native UI/account pass is pending; its results
belong in [implementation status](implementation.md). The evidence below records
earlier account/backend and scaffold checks, not a public deployment claim.

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

The native app mounts the session-isolated Architect editor and uses the same
account/publication services. Configure `UNITY_ARCHIVE_NATIVE_ORIGIN` for native
Archive references as described in [existing Archive storage](archive-existing-storage.md).
`UNITY_ARCHIVE_ORIGIN` belongs to the retained fixture/copied selection workflow
described in [Archive import](archive-import.md); it is not a live-corpus migration.

The [local Worker profile](worker-profile.md) now uses the same account API over
D1/R2, with a platform login-rate binding and operator commands for local state.
Its separate real-Wrangler browser rehearsal proves two-account publication/fork
and restart persistence. External-instance discovery, richer publication management,
general asset transport and remote Worker hosting/production ingress remain open.
Live Archive writer takeover, real embedding-provider acceptance and Foundry
publishing remain held. No production accounts, external deployment or corpus copy
are created by the native browser work.
