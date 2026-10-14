# Node containers

The image packages the shared Node API, operator CLIs and native Unity UI. Both
account and single-owner local profiles serve that same application from
`/app/web/unity` by default, including native sharing and configured remotes.
The old Hub and Architect scaffold builds are retired and are not staged.
It uses a digest-pinned Node 24.19.0 Debian image, pnpm 11.20.0, frozen dependency
lockfiles and the exact external Foundry commit in `foundry-sdk.json`. Docker
fetches/builds that SDK inside the builder; no sibling checkout, developer
`node_modules`, credentials or local storage enters the build context.
The final stage contains the bundled apps and native SQLite dependency closure.
No compiler, Git checkout or SDK source is copied from the builder.

Fresh image builds are currently **blocked by the held Foundry publication**:
`foundry-sdk.json` pins `76990644da2b8d79bd57a2a7f3c6e46a5b6aee92`, which is not
yet available from its configured public repository. A prepared local SDK checkout
can verify local bundles/staging, but it does not prove a fresh Docker bootstrap.
Do not substitute the released SDK: it lacks the card-identity code this app uses.
The build/rehearsal commands below apply once the owner releases that pin.

The Node process runs as UID/GID 1000. Compose uses a read-only root filesystem,
ephemeral `/tmp`, no capabilities and a dedicated writable volume at `/data`.
That volume contains Unity's database and immutable blobs. Keep it separate from
Archive. New Docker named volumes inherit the image's writable directory ownership;
an existing bind-mounted directory must already be writable by UID 1000.

## Local hub rehearsal

From the Unity repository, with Docker Engine and Compose installed:

```sh
docker build --tag character-unity:local .
UNITY_PUBLIC_ORIGIN=http://127.0.0.1:9312 docker compose up -d
docker compose exec hub node accounts-cli.js create --name Alice --key-file /tmp/alice.json
docker compose cp hub:/tmp/alice.json /private/unused-alice-key.json
```

Replace the last destination with a new path in an existing private directory.
The CLI creates mode-0600 key files and refuses to overwrite them. Copy the key
out before recreating the container because `/tmp` is ephemeral; keep the copy
private and outside this repository. Read its `key` value to sign in at
`http://127.0.0.1:9312`. Create other accounts with distinct names/key-file paths.
Listing, rotating and disabling accounts use the same CLI, for example
`docker compose exec hub node accounts-cli.js list`.

The hub listener binds to `0.0.0.0` **inside** the container. Compose publishes it
only on host loopback. Startup requires an exact `UNITY_PUBLIC_ORIGIN`; account
authentication, Host/Origin validation and session revocation apply to every
domain operation. `GET /api/health` and `/api/ready` are public readiness routes.

For HTTPS hosting, set `UNITY_PUBLIC_ORIGIN=https://your-host.example` and use a
reverse proxy that terminates TLS, preserves Host, Origin and cookies, and sends
requests to the loopback port. Forwarded Host/Proto headers do not select trusted
origins. The configured HTTPS origin produces Secure, HttpOnly, SameSite=Strict
`__Host-` cookies. The repository does not provision DNS, certificates or a public
proxy. Do not expose the backend's HTTP port directly to the public network.

Signed sync remains disabled by default. For an HTTPS hub with explicitly
provisioned peers, Compose passes `UNITY_SYNC_ENABLED=true` through to the host.
`UNITY_SYNC_WRITES_ENABLED=true` separately enables publication/fork commands and
requires signed reads. See [sync setup and limits](sync-foundation.md). The
rehearsal enables both flags only on its isolated temporary hub.

`docker compose stop` and `docker compose down` retain the named volume.
`docker compose down --volumes` deletes it, including cards and account data.
Use one API writer per volume. `backup-cli.js` creates a consistent SQLite snapshot
and verified owned-blob bundle; restore writes only a new isolated directory.
See [backup and recovery](asset-maintenance.md). Off-host backup scheduling and
live recovery drills remain operator work.

## Local Unity on Linux

```sh
docker compose -p unity-architect -f compose.architect.yaml up -d --build
```

Open `http://127.0.0.1:9314`. `ARCHITECT_PORT` changes that port. The historical
Compose filename, service, project name and named volume are retained so existing
installs keep their data. This profile serves native Unity with the single-owner local
session. It uses Linux host networking so the server still binds to actual
loopback. Setting `UNITY_PROFILE=local` while retaining the hub's wildcard HOST
fails startup. There is no unauthenticated bridge-network exception.

Retiring the old UI does not delete or migrate browser-origin IndexedDB data. The
native browser-only profile remains available through `pnpm build:browser`;
its existing origin/profile storage is not the native application's server library.
Do not clear that site storage as part of this UI switch.

Linux host networking was exercised by the earlier scaffold container rehearsal;
the native UI's current distribution has only been staged and checked locally.
Fresh container verification remains gated on the held Foundry publication below.
Host networking has different
availability/semantics on other platforms; see Docker's
[host network documentation](https://docs.docker.com/engine/network/drivers/host/).
For a portable static site, use the existing `pnpm build:browser` output described
in [browser storage](browser-storage.md); that profile needs no Node API/container.

## Repeatable verification

```sh
pnpm bootstrap # prepares the pinned public SDK used by the independent client
docker build --tag character-unity:foundation .
node scripts/verify-container.mjs character-unity:foundation
```

The script requires Node 24, the bootstrapped workspace/SDK, Docker Engine on Linux
and OpenSSL. It uses uniquely
named containers/volumes and an ephemeral loopback HTTPS proxy with a certificate
trusted only by its own HTTP client. It removes its own containers, volumes and
temporary certificate/key files on completion, retaining the built image and a
non-secret `runtime/container-rehearsal.json` report. Failure logs stay in ignored
`runtime`. It never connects to live Archive or another application's data.

Checks cover native SQLite schema readiness, non-root/read-only operation, the
native UI entry/deep links and exact tokenizer worker bytes, native local-session
hosting and native restart on the same volume, two CLI-created accounts including explicit public actor
provisioning, HTTPS cookie attributes, rejected
origins/hosts, ignored forwarded headers and actor-proof rejection for JSON/binary
operations, an asset-bearing PNG edit/publication/
fork/CharX reimport, unchanged original bytes, account revocation, persistence of
sessions/revisions/blobs through container replacement, signed read/publish/fork
requests from the public SDK over real HTTPS, a pulled card forked/edited by that
client and returned with verified ancestry/assets before explicit publication,
exact source-bundle preservation and stable receipts after replacement,
and refusal of receipt recovery after account suspension, image healthchecks and
graceful termination. The local-profile checks use one isolated volume and a temporary host port.
This tests HTTP transport and cookie headers, not browser certificate installation.

CI builds and runs this rehearsal separately from `pnpm check`; it does not push
an image or deploy. It cannot pass its fresh-build stage until the held Foundry
commit is published; local staging alone is not container verification.
The clean install validates the dependencies actually used by
Unity's Node profile. Archive has a [separate image and native search rehearsal](archive-native-runtime.md).
These probes do **not** validate full legacy search parity,
ARM images, remote ingress, Workers hosting or asset preservation through an
external application. Dependency/base-image pins do not make networked apt/npm
installation a bit-for-bit reproducible or offline build.

The [Worker profiles](worker-profile.md) host the same native UI, either with
account API/D1/R2 or browser-only storage. Their local verification does not
provision remote resources or migrate existing browser data.

The API image also includes `assets-cli.js` for explicit SQLite/filesystem
maintenance. Preview and sweep packaging run in the container rehearsal. See
[asset maintenance](asset-maintenance.md) for exact-ID retirement, paging,
retry rules and the required database/blob-directory pairing.
