# Asset lifecycle service

`createAssetService(store, blobs)` connects workspace metadata to verified immutable
bytes. The Node composition root in `apps/api/src/services.ts` initializes this
service with Unity-owned SQLite and filesystem storage.

1. `stage` records expected SHA-256, size and media type, generating an asset ID and
   storage key in the selected workspace. The service enforces a 32 MiB default cap.
2. `upload` retrieves that workspace's staged declaration, streams bytes through
   the blob verifier, and only then marks the asset ready. A default 120-second
   deadline and optional caller signal cancel stalled streams.
3. `download` requires a ready asset in the requested workspace and returns existing
   bytes only. Missing or length-mismatched objects fail; it never fetches or repairs.

Both limits are configurable. Reads do not rehash the entire object before serving;
integrity is established at ingestion and objects cannot be overwritten through
the storage API. Disk/R2 administration remains a trusted operational boundary.

If bytes commit but SQL completion fails, the object stays immutable and metadata
stays staged. A retry verifies the existing bytes and completes the same record.
The service never deletes a committed object on a database error: another upload
may already have successfully completed it. Temporary upload files/objects are
cleaned by the storage adapters during normal success/failure. Explicit operator
retirement and retryable sweeps reclaim unreferenced SQL-owned final objects; see
[asset maintenance](../../docs/asset-maintenance.md). Explicit offline Node orphan
commands reclaim reviewed old crash leftovers without touching SQL-owned keys or
Archive bytes. Remote R2 lifecycle policies and IndexedDB reclamation remain separate.

This is a trusted host service. Account/workspace authorization belongs in the
calling card operations. HTTP revision-asset uploads and downloads now use those
authorized operations; see [asset revisions](../../docs/asset-revisions.md).
Directly accepting client-reported measurements into `store.completeAsset` would
bypass verification; HTTP handlers must use this service instead.
