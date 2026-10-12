# Persisted sync sender foundation

The shared host composition exposes `services.remote(connection)` and, for an
account session, `services.forSession(proof).remote(connection)`. These use
`@character-unity/cards/remote` with the same guarded store and asset service as
the editor. Hosts supply an explicit Foundry connection: exact HTTPS `baseUrl`,
`actor`, `keyId` and an Ed25519 `privateKey`. The connection is captured when the
service is created. Keys/URLs are not accepted through a public HTTP request body.

The [configured hub workflow](remote-hubs.md) exposes account-scoped browsing,
pull, preparation and retry routes. Operators supply the connections; the browser
cannot choose arbitrary URLs or keys. [Durable return jobs](sync-outbox.md) are
available through `remote.returns`. There is no background polling or
automatic remote publication. Foundry supplies signing, reads, identity, bundle
encoding and verification; Unity supplies authorization and persistence.

## Public account identities

For a new account that will author remote forks, provision a stable HTTPS URI:

```sh
pnpm accounts create --name Bob --actor-uri https://editor.example/actors/bob --key-file /tmp/bob-account.json --database "$PWD/runtime/editor.db"
```

The same option works with `--worker-state DIRECTORY`. The URI must be canonical,
HTTPS, at most 1024 characters and contain no credentials, query or fragment. It
is unique in that database and immutable, including across key rotation. This is
an operator assertion of identity, not DNS ownership verification, key discovery
or a newly served actor endpoint. Provision the signing key and corresponding
peer grant separately on the receiving hub.

Omitting `--actor-uri` retains `urn:unity:user:ACCOUNT_ID`. Existing accounts and
saved lineage are never renamed. A legacy account needs a separately provisioned
public identity and an explicit fork flow; changing embedded authors to make a
signature match is not supported. Public actor provisioning grants no remote
permission and does not enable the host's sync routes.

## Pull an explicit fork

`pullFork(actor, workspaceId, publicationId, signal?)` means an explicit local
fork, not merely opening or reading a card. The local actor must match the
configured signing actor and own the workspace. Authorization precedes network
reads. The service:

1. Fetches the selected publication with the signed Foundry read client and
   requires its fork policy to allow the operation.
2. Verifies every asset and re-reads the publication to detect policy/snapshot
   changes during the pull. No untrusted asset URL is fetched.
3. Creates one explicit fork lineage record under the local account's HTTPS URI,
   preserving the remote original-root hash and known parent record.
4. Confirms the resulting draft fits the 8 MiB return-bundle profile, before any
   asset staging or card writes.
5. Stores immutable asset copies and the exact canonical publication snapshot as
   the accepted source. Source provenance records the configured destination,
   remote publication ID and local actor. The card/source/revision references
   commit together through the existing store operation.

The source snapshot includes the original remote document and manifest, not the
new local fork record. The editor opens the resulting ordinary workspace card
and uses its existing revision/asset save routes. The snapshot remains unchanged.
The remote original and remote store receive no writes during a pull.

Repeating `pullFork` intentionally creates another draft; it is not a deduplicated
background import. All downloads/preflight finish before staging. Interrupted or
failed storage preparation can leave unlinked assets for future operator cleanup.
A remote policy check cannot atomically commit with a different local database;
previously delivered bytes cannot be retracted. Return acceptance rechecks the
receiver's current policy independently.

## Prepare one saved revision for return

`prepareReturn(actor, workspaceId, cardId, revisionId, signal?)` reads one explicit
saved revision. It never silently substitutes the current head. It verifies the
stored source snapshot and its destination/actor/root binding, walks that card's
saved history and reads/verifies the selected revision's assets. Foundry validates
the connected sender-attributed ancestry and produces the canonical binary bundle.

The result contains `bytes`, SHA-256 `hash`, media type, destination, parent ID and
local card/revision IDs. Preparation performs no network calls and no writes.
The same selected revision produces identical bytes after restart, including when
a newer head exists. Retargeting a draft to another destination or actor fails.
Longer-than-supported ancestry, missing assets or corrupt source bytes fail rather
than rewriting lineage or silently dropping data. Existing URN records cannot be
relabeled for return.

Preparation alone does not persist an outbound job or receipt. Use
`remote.returns.enqueue` with an explicit `createSyncToken()` operation ID to save
the exact frame and selection **before** sending. `remote.returns.send` records an
attempt before dispatch and saves the acknowledgment; retries reuse the same ID
and bytes. See [durable return jobs](sync-outbox.md).
The receiver returns a private draft reference; publication remains a separate
explicit selected-revision command. The hub now provides review and retry
controls, with publication performed separately on the receiving hub.

## Evidence

Account requirement A07 runs on SQLite and D1: explicit public identities, unchanged
URN defaults, invalid/duplicate URI rejection, immutable identities, captured inputs
and concurrent uniqueness. Real Node and local-D1 account CLI tests exercise the
flag and protected key files.

The sync integration suite opens an independent persisted Node Unity instance,
creates a public account, pulls from either the SQLite host or actual Worker D1/R2,
edits through the second account API, saves a newer unselected head, restarts the
sender and prepares the identical earlier revision offline. It then submits and
publishes that revision through the signed SDK and verifies lineage/assets and
unchanged originals. Retargeting and revoked local sessions fail. Corrupt remote
bytes, a mid-pull policy change and in-flight session revocation cause no staging.

These are shared-service/account-API integration tests. They also exercise durable
job recovery after a lost remote acknowledgment, restart and signing-key rotation.
A separate browser rehearsal now exercises two compiled Node hosts over HTTPS,
including exact assets, lost enqueue/return responses and explicit receiving-hub
publication; see [connected hubs](remote-hubs.md). The separate
container rehearsal verifies compiled public-actor provisioning and the existing
HTTPS SDK pull/edit/return path; it does not exercise a sender UI.
