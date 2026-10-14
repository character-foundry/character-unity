# Connected hubs

The native `apps/web` application can browse a configured peer at `/remotes`, pull
a private fork, edit it with the session-isolated Architect editor, prepare an
exact saved or historical revision for return, and explicitly send or retry that
return. A successful return creates a private draft on the receiving hub. Its
account can review and publish the received revision separately.

Connections belong to a local account and its immutable HTTPS actor. Operators
configure destinations and signing keys on the host. Browser requests select a
connection ID; they never supply a URL, private key, filesystem path or different
account. Foundry owns the signed protocol, verification and bundle encoding.
The same shell provides local publication controls at `/sharing`; the earlier
`apps/hub` scaffold has been retired.

## Current opaque-resource limit

Same-hub publication preserves opaque Risu `module.risum` bytes. The current
Unity-to-sync mapping cannot represent that binding. Such publications are
excluded as whole records before signed-list pagination; direct signed reads
return an explicit unsupported-resource error (422). Ordinary publications remain
visible, and neither local publication nor original bytes are stripped. Sharing
discloses the limitation. Ordinary PNG/JSON and declared-attachment returns are
covered by the native TLS browser rehearsal. A future wire extension is separate
work, not a silent conversion.

## Configure the sender

Create a sender account with a public actor and generate its signing pair:

```sh
pnpm accounts create --name Editor --actor-uri https://editor.example/actors/editor --key-file runtime/editor-account.json
pnpm peers keygen --private-key-file runtime/editor-signing.pem --public-key-file runtime/editor-public.pem
```

These commands use the existing operator CLI. The account key is for signing in
to the sender's hub; the signing pair is for peer requests. See [account setup](hub-accounts.md)
and [peer provisioning](peer-operators.md). The actor URI is an operator assertion,
not DNS ownership verification or a newly served actor endpoint.

Create a protected configuration file outside the served web assets:

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
const { account } = JSON.parse(await readFile('runtime/editor-account.json', 'utf8'));
const configuration = {
  version: 'unity.remote-connections.v1',
  connections: [{
    id: 'friends',
    name: 'Friends hub',
    accountId: account.id,
    actor: account.uri,
    baseUrl: 'https://friends.example/api/sync/v1',
    keyId: `${account.uri}#one`,
    privateKeyPem: await readFile('runtime/editor-signing.pem', 'utf8'),
  }],
};
await writeFile('runtime/connections.json', JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
JS
```

Node loads `UNITY_REMOTE_CONNECTIONS_FILE` at startup in the `hub` profile. It
rejects symlinks, non-regular files, group/world-accessible permissions, oversized
files and invalid configuration. The JSON is limited to 128 KiB and 16 connections.
Connection IDs are unique; duplicate account/actor/destination mappings fail.
Each record requires exactly the fields shown above. Keys must be Ed25519 PKCS8
private PEM and are imported as non-extractable signing keys.

Set `UNITY_REMOTE_CONNECTIONS_FILE` to the file's absolute path when starting the
hub as described in [hub accounts](hub-accounts.md). In a container, mount it
read-only at an explicit path readable by the runtime user, retain owner-only
permissions, and set that environment variable. The default Compose profile has
no outgoing connection file. No secret is compiled into web assets or baked into
the image.

The Worker accepts the same JSON in the secret binding
`UNITY_REMOTE_CONNECTIONS_JSON`; do not put private keys in public Wrangler vars.
The shared parser and request-scoped D1/R2 services handle the same routes.
An omitted file/binding means no configured outgoing connections. Invalid
configuration fails closed. Node configuration changes require restart; Worker
configuration changes follow its secret/deployment lifecycle.

## Configure the receiver

On the receiving hub, provision the local account/workspace that will own returned
drafts. Give the sender's public actor an explicit grant and pin its public key:

```sh
pnpm peers grant --actor https://editor.example/actors/editor --account RECEIVER_ACCOUNT_ID --workspace RECEIVER_WORKSPACE_ID --scopes pull,fork
pnpm peers add-key --actor https://editor.example/actors/editor --key-id https://editor.example/actors/editor#one --public-key-file /path/to/editor-public.pem
```

The receiver needs an HTTPS public origin, `UNITY_SYNC_ENABLED=true` and
`UNITY_SYNC_WRITES_ENABLED=true`. The sender needs only its outgoing configuration;
it does not need to expose signed incoming routes. `pull,fork` permits the browser
workflow described here; it does not authorize automatic signed publication.
Local Node and local D1 provisioning are implemented. Remote resource provisioning
and deployment are separate operational work.

For signing-key rotation, pin the replacement public key on the receiver and
update the sender's key ID/private key while retaining its actor and destination.
Previously queued jobs keep their bytes and operation IDs. Removing a connection
leaves jobs readable with an unavailable-connection label and disables sending;
restoring the same account/actor/destination makes them eligible for retry again.

## Browser workflow

1. Sign in to the sender's native app and choose a workspace. Under **Remotes**, choose
   the configured connection and browse its visible publications.
2. **Pull fork** copies a verified snapshot and assets into the private workspace.
   The native app opens the pulled fork in its editor. Unsaved edits are not sent.
3. Save edits, choose **Saved revision to return**, optionally use **Choose another
   saved revision** for paginated history, then **Prepare return**. The
   review shows the pinned revision, destination, saved content and asset count.
   Later saves do not replace the selected revision.
4. **Send saved return** dispatches the persisted job. An uncertain outcome offers
   **Retry saved return** with the same bytes and operation ID. It never silently
   starts a new operation or publishes the result.
5. Sign in to the receiving account, review the new private draft and publish an
   explicit saved revision using its existing publication controls.

Before enqueueing, the native browser records the preparation ID and selection
in actor/workspace-scoped local storage. A lost response survives a tab reload
and offers **Retry preparation** with the same operation ID. Unreadable notices
require explicit dismissal; they are not silently replaced. The server's
saved-return list is authoritative once a job exists. Clearing browser storage
can lose an unconfirmed preparation notice; refresh saved returns before
preparing another. Dismissing the notice never deletes an existing server job.
The browser notice is not a substitute for the durable server outbox.

Archive references cannot be selected for return: they are read-only links, not
remote-owned drafts. Saving unchanged content creates no copy. Save a changed
owned fork before using owned-revision workflows, and only return a fork pulled
from the selected configured hub. For ordinary local publication, use Sharing.

Remote errors have `REMOTE_` codes and do not expire the local session. Local
session expiry or an account change locks the app for same-account recovery and
retains the mounted editor state. The remote client captures one immutable actor
and workspace; a later login or selection cannot retarget its pending requests.
Signing keys, key IDs and account credentials are absent from connection/job
responses. See [outbox state and recovery](sync-outbox.md) for receipt semantics.

## Routes and verification

All routes below use the account API's cookie, origin and expected-account checks.
The native JSON and binary clients use the same captured authenticated connection:

| Route | Effect |
|---|---|
| `GET /api/remotes/connections` | List this account's public connection descriptors |
| `GET /api/remotes/connections/:id/publications?workspaceId=...` | Verified signed publication page, at most 20 |
| `POST /api/remotes/connections/:id/pulls` | Explicit private fork into the selected workspace |
| `GET /api/remotes/workspaces/:workspace/jobs` | Paginated saved-return metadata, including unavailable connections |
| `POST /api/remotes/workspaces/:workspace/jobs` | Persist one exact selection and caller-supplied operation ID |
| `GET /api/remotes/workspaces/:workspace/jobs/:id` | Read one saved job and historical acknowledgment |
| `POST /api/remotes/workspaces/:workspace/jobs/:id/send` | Send or retry its existing bytes; body must be `{}` |

See [implementation status](implementation.md) for verification gates. HTTP tests cover
connection/account isolation, URL/key injection rejection,
cookie separation, redacted descriptors, removed connections, peer-error mapping
and local revocation against SQLite and workerd receivers. Additional tests run
the sender itself inside workerd, including PKCS8 import, outbound SDK signing,
R2 assets, D1 jobs, response loss and receipt recovery after restarting the sender.
Those Worker tests bridge outbound requests through the test harness; they do not
establish deployed networking or platform limits.

`e2e/unity-editor/sharing.spec.ts` runs two compiled Node hosts behind a local HTTPS peer
proxy with a test-only trusted certificate. Real browser actions publish a card
with an attachment, pull/edit it, recover a lost enqueue response across reload,
retain a newer head and unsaved draft, and retry after the proxy loses a successful
receiver response. The receiver has one returned draft, exact asset bytes,
explicit later publication, visible parent linkage and unchanged original bytes.
Another account cannot discover or use the connection. The mobile screenshot is
saved with the test artifacts. These checks run in `pnpm check`; remote hosting,
operational cleanup and live Archive adoption remain open. Live Archive writer
takeover, real embedding-provider acceptance and Foundry publishing remain held;
this UI work does not activate them or deploy a public hub.
