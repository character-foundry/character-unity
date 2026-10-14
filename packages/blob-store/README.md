# Immutable byte storage

Filesystem and R2 adapters share a streaming `put`/`get` contract. This package
stores bytes; character parsing, canonical card identity and lineage remain
Foundry primitives. Neither adapter downloads URLs or rewrites originals.

```ts
import { createNodeBlobStore } from '@character-unity/blob-store/node';
const blobs = await createNodeBlobStore('/path/to/unity-owned/blobs');
```

Within a Worker, use `createR2BlobStore` from `/r2` with the bucket binding and
`(length) => new FixedLengthStream(length)`. The factory injects the Workers-only
stream constructor so no Node shims or globals enter the portable module.
No remote R2 bucket has been created or configured in the app yet.

`put(key, stream, { hash, byteLength }, { signal })` checks the whole stream against
a lowercase SHA-256 digest and exact length before publishing. The default cap is
32 MiB per object, configurable at construction. Larger files are rejected, never
resized. Backpressure keeps memory bounded to chunks; each chunk is copied before
hashing/writing so a producer cannot change bytes during an asynchronous write.

Keys have the form `assets/<lowercase-alphanumeric-or-hyphen-id>` or
`originals/<lowercase-alphanumeric-or-hyphen-id>`, with an identifier up to 128
characters. They are storage identifiers, not user filenames or filesystem paths.
Reads return existing bytes and their length; callers must consume or cancel
the stream. There is intentionally no public overwrite or delete method.

## Commit and retry behavior

Node writes a private temporary file, verifies and syncs it, then atomically
hard-links it into its final namespace. Existing files are not replaced. Reads
reject a final symlink; namespace directories must be real directories. The root
directory is trusted, operator-owned storage and must not be a live Archive path.

R2 first streams to a random temporary object using a fixed-length stream and
R2's checksum validation. After verification, it streams that object into the
final key with a conditional create. This deliberately costs a staging write/read
to prevent a rejected stream from publishing a valid prefix as a completed object.
The API uses the documented [R2 conditional writes and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

Identical retries re-read and verify existing objects; different bytes at an
existing key fail. Temporary objects are removed on normal completion and failure.
Cleanup failures surface to the caller. Hard process termination/provider failures
can leave temporary objects. Explicit offline Node orphan maintenance rechecks
reviewed physical-file tokens, age and SQL ownership before deletion; see
[asset maintenance](../../docs/asset-maintenance.md). Remote R2 lifecycle policies
remain operator work. Completed but unreferenced objects are retained for safe
recovery until explicit retirement, never deleted by a failed database transaction.

The [asset service](../assets/README.md) coordinates these bytes with staged store
metadata. See [test coverage](tests/COVERAGE.md) for the tested guarantees and limits.
