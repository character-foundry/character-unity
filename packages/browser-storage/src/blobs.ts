import { BlobError, defaultMaxBytes } from '@character-unity/blob-store';
import type { BlobIntegrity, BlobStore } from '@character-unity/blob-store';
import { cancelBody, consumeVerified, validateIntegrity, validateKey } from '@character-unity/blob-store/verify';
import { request, transaction } from './transaction.js';

interface BlobRow extends BlobIntegrity { key: string; bytes: Blob }
export function createBrowserBlobs(db: IDBDatabase, maxBytes = defaultMaxBytes): BlobStore {
  return {
    async put(key, body, expected, options = {}) {
      try {
        expected = { ...expected };
        validateKey(key); validateIntegrity(expected, maxBytes);
        // IDB accepts a Blob as one value. Buffer at most the declared, bounded size,
        // and never keep an IDB transaction alive across stream/hash work.
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        const measured = await consumeVerified(body, expected, async (chunk) => { chunks.push(new Uint8Array(chunk)); }, options.signal);
        const candidate: BlobRow = { key, ...measured, bytes: new Blob(chunks) };
        const existing = await transaction(db, ['blobs'], 'readwrite', function* (tx) {
          const old = yield* request<BlobRow | undefined>(tx.objectStore('blobs').get(key));
          if (options.signal?.aborted) throw new BlobError('ABORTED', 'Upload aborted');
          if (old) {
            if (old.hash !== measured.hash || old.byteLength !== measured.byteLength || old.bytes.size !== measured.byteLength) {
              throw new BlobError('INTEGRITY', 'Immutable object already has different bytes');
            }
            return old;
          }
          yield* request(tx.objectStore('blobs').add(candidate));
          if (options.signal?.aborted) throw new BlobError('ABORTED', 'Upload aborted');
          return undefined;
        });
        if (existing) await consumeVerified(existing.bytes.stream(), expected, async () => undefined, options.signal);
        return measured;
      } finally { await cancelBody(body); }
    },
    async get(key) {
      validateKey(key);
      const stored = await transaction(db, ['blobs'], 'readonly', function* (tx) {
        return yield* request<BlobRow | undefined>(tx.objectStore('blobs').get(key));
      });
      return stored ? { body: stored.bytes.stream(), byteLength: stored.bytes.size } : null;
    },
  };
}
