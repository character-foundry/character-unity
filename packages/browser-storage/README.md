# Browser storage

`openBrowserStorage({ name? })` returns `{ store, blobs, close }`. The store
implements the same trusted domain operations as `@character-unity/store`; blobs
implement `BlobStore`. Default database: `character-unity:architect`. Custom names
must use the `character-unity:` namespace. No Foundry code is copied here.

Compose these adapters with `createAssetService` and `createCardService`. Do not
call database internals from editor components. Writes are native atomic IDB
transactions, never async transaction callbacks; verified bytes are prepared
before a write begins. `close()` closes this connection without deleting data.
Connections also close on a database version change. See
[the profile contract](../../docs/browser-storage.md) for bounds, failure behavior,
proofs and remaining storage lifecycle work.
