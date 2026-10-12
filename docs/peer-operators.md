# Peer and key operators

`pnpm peers --help` lists the local operator commands. They configure peer trust
for the signed-sync foundation. Host flags separately enable signed reads and
publish/fork commands; provisioning a grant does not change those flags.
Each peer maps one exact HTTPS actor URI to one local account/workspace and an
explicit subset of `pull`, `publish` and `fork` scopes. The mapping is immutable.
Incoming actor/key URLs identify records; no key URL is fetched.

Commands use `--database FILE`, defaulting to `UNITY_DB_PATH` or the API package's
`runtime/unity.db`. Use `--worker-state DIRECTORY` instead for local D1. These flags
are mutually exclusive. D1 uses the same absolute directory as Wrangler's
`--persist-to`, with remote bindings disabled. Stop local dev during operator
commands: opening the store inspects and applies migrations. None of these commands
reads Archive's database, files or search index.

## Generate a key on the signing side

```sh
mkdir -p runtime
pnpm peers keygen --private-key-file "$PWD/runtime/peer-one.private.pem" --public-key-file "$PWD/runtime/peer-one.public.pem"
```

Both files are created exclusively with mode `0600`; existing files are never
replaced. The private key is Ed25519 PKCS8 PEM. The public key is Ed25519 SPKI PEM.
Only file paths and a `SHA256:` fingerprint of the raw 32-byte public key appear
in command output. Private keys stay in their files, outside the Unity database.
If output creation fails, newly reserved files may be empty or incomplete; choose
fresh paths after inspecting them. No existing output file is removed.

Transfer only the public file to the receiving operator through your chosen
channel. Compare its fingerprint through a trusted channel before granting access.
The CLI does not perform that transfer. `add-key` accepts a bounded regular SPKI
public PEM file; it rejects private keys, other algorithms and symlinks.

## Grant a receiving workspace

Create a local account with `pnpm accounts create` and create its workspace in the
hub. Find its workspace ID with:

```sh
pnpm peers workspaces --account ACCOUNT_ID --database "$PWD/runtime/hub.db"
```

This returns at most 100 workspaces and reports `possiblyTruncated` when that limit
is reached. Account credentials and database paths should match the hub profile
in [account setup](hub-accounts.md).

On the receiving side, use the actor URI and key ID the sender will sign with:

```sh
pnpm peers grant --actor https://sender.example/actors/alice --account ACCOUNT_ID --workspace WORKSPACE_ID --scopes pull,publish --database "$PWD/runtime/hub.db"
pnpm peers add-key --actor https://sender.example/actors/alice --key-id 'https://sender.example/actors/alice#one' --public-key-file "$PWD/runtime/alice.public.pem" --database "$PWD/runtime/hub.db"
pnpm peers show --actor https://sender.example/actors/alice --database "$PWD/runtime/hub.db"
```

The key ID must be a fragment of that exact actor URI. Importing a key grants no
additional scopes. A peer without a key cannot authenticate. An account must be
enabled and own the selected workspace when the grant is created; admission and
mutation transactions independently recheck ownership and current authorization.

For local D1, replace `--database ...` with
`--worker-state "$PWD/runtime/worker-state"` on each database command. The account
and workspace must exist in that D1 store. The development checkout includes the
Wrangler dependency needed for this profile; the Node runtime container does not.

## Inspect, rotate and revoke

`peers list [--after ACTOR] [--limit 1..100]` returns a stable actor-ordered page.
`peers show --actor URL [--after-key KEY_ID] [--limit 1..100]` reports the mapping,
peer enablement, account enablement, scopes, public-key hex bytes, fingerprints and
revocation state. A full page returns a continuation cursor; the final continuation
may be empty. Inspection is operator metadata, not an authorization credential.

After generating and transferring a replacement public key:

```sh
pnpm peers rotate-key --actor https://sender.example/actors/alice --old-key-id 'https://sender.example/actors/alice#one' --key-id 'https://sender.example/actors/alice#two' --public-key-file "$PWD/runtime/alice-two.public.pem" --database "$PWD/runtime/hub.db"
```

The replacement insertion and old-key revocation share one SQL transaction.
Missing/revoked old keys, reused replacement IDs and failed batches leave the old
state intact. Concurrent rotations from one old key admit only one replacement.
For an intentional overlap, use `add-key` first and later `revoke-key` instead.
Revocation is permanent; enabling a peer never unrevokes a key. Existing nonces and
operation receipts retain their actor identity through rotation.

```sh
pnpm peers scopes --actor https://sender.example/actors/alice --scopes pull --database "$PWD/runtime/hub.db"
pnpm peers scopes --actor https://sender.example/actors/alice --scopes none --database "$PWD/runtime/hub.db"
pnpm peers disable --actor https://sender.example/actors/alice --database "$PWD/runtime/hub.db"
pnpm peers enable --actor https://sender.example/actors/alice --database "$PWD/runtime/hub.db"
pnpm peers revoke-key --actor https://sender.example/actors/alice --key-id 'https://sender.example/actors/alice#two' --database "$PWD/runtime/hub.db"
pnpm peers prune-nonces --database "$PWD/runtime/hub.db"
```

`prune-nonces` removes only claims strictly older than the trusted host clock,
including their skew retention. It preserves receipts. There is no delete-peer,
unrevoke-key or receipt-pruning command.

## Built commands and verification

After `pnpm build`, use `node apps/api/dist/peers-cli.js ...`. The staged Node
runtime includes `peers-cli.js`, so a container operator can run
`node /app/peers-cli.js ... --database /data/unity.db`. Key files need a mounted,
writable path. The CLI emits one JSON result on success or a JSON error on stderr
with a nonzero exit status; `--help` is text. Package-manager script banners are
outside that JSON stream, so use the built Node command for automation.

Shared SQLite/D1 conformance checks inspection, deterministic pagination and
atomic rotation with failure injection and races. Tests run the compiled CLI on
native SQLite and Wrangler's persisted local D1, then verify real signatures with
the public Foundry SDK. They cover exclusive files, secret-free output, malformed
input, scopes, rotation/replay persistence and revocation. The fresh Node container
rehearsal also passes packaged peer inspection, protected key generation and
non-disclosure of the operator executable through the web server. See
[signed sync foundation](sync-foundation.md) for the available HTTP commands and remaining remote submission,
interoperability and abandoned-upload work.
