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

IndexedDB schema v3 upgrades recognized v1/v2 libraries in place. It adds the
same exact-version Archive references, metadata-only external assets, independent
fork ancestry, atomic import claims, opt-in shared asset staging and guarded
search outbox as SQLite/D1. Existing cards, favorites, revisions and blobs remain
unchanged. Upgrade rejects an unrecognized schema marker instead of replacing it.
Existing owned heads enqueue metadata-only search jobs; no Archive bytes are
copied and the store starts no polling. Resolving external bytes still requires
the host's Archive connection.

Chat targets and placement observations remain server-only. Browser-only
`has:chat` therefore matches no rows; it does not infer chat presence from cached
Archive flags or retained identity metadata.
