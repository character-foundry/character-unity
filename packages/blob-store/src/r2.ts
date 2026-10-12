import type { R2Bucket, FixedLengthStream } from '@cloudflare/workers-types';
import { BlobError, defaultMaxBytes } from './index.js';
import type { BlobStore, StoredBlob } from './index.js';
import { byteStream, cancelBody, consumeVerified, validateIntegrity, validateKey } from './verify.js';

/** Inject the native Workers FixedLengthStream constructor; it is not available in Node. */
export function createR2BlobStore(bucket: Pick<R2Bucket, 'get' | 'put' | 'delete'>,
  fixedLength: (length: number) => FixedLengthStream, options: { maxBytes?: number } = {}): BlobStore {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  validateIntegrity({ hash: '0'.repeat(64), byteLength: 0 }, maxBytes);
  async function get(key: string): Promise<StoredBlob | null> {
    validateKey(key);
    const object = await bucket.get(key);
    return object ? { body: byteStream(object.body.getReader()), byteLength: object.size } : null;
  }
  return {
    get,
    async put(key, body, expected, options = {}) {
      let pending: string | undefined;
      try {
        validateKey(key); validateIntegrity(expected, maxBytes);
        const integrity = { ...expected };
        pending = `pending/${crypto.randomUUID()}`;
        const stream = fixedLength(integrity.byteLength);
        const writer = stream.writable.getWriter();
        const failed = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
        const abort = () => { void writer.abort(signal.reason).catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        const uploading = bucket.put(pending, stream.readable, { sha256: integrity.hash }).catch((error: unknown) => {
          failed.abort(error);
          throw error;
        });
        const feeding = consumeVerified(body, integrity, (chunk) => writer.write(chunk), signal)
          .then(async (measured) => { await writer.close(); return measured; })
          .catch(async (error: unknown) => { await writer.abort(error).catch(() => undefined); throw error; });
        const [fed, uploaded] = await Promise.allSettled([feeding, uploading]);
        signal.removeEventListener('abort', abort);
        writer.releaseLock();
        if (fed.status === 'rejected') throw fed.reason;
        if (uploaded.status === 'rejected') throw uploaded.reason;
        if (options.signal?.aborted) throw new BlobError('ABORTED', 'Upload aborted');
        const staged = await bucket.get(pending);
        if (!staged) throw new BlobError('INTEGRITY', 'Verified staging object is missing');
        try {
          const published = await bucket.put(key, staged.body, {
            sha256: integrity.hash, onlyIf: { etagDoesNotMatch: '*' },
          });
          if (!published) {
            const existing = await get(key);
            if (!existing) throw new BlobError('INTEGRITY', 'Conditional write failed without an existing object');
            await consumeVerified(existing.body, integrity, async () => {}, options.signal);
          }
        } finally {
          if (!staged.body.locked) await staged.body.cancel().catch(() => undefined);
        }
        return fed.value;
      } finally {
        await cancelBody(body);
        if (pending) await bucket.delete(pending).catch((error: unknown) => {
          throw new BlobError('CLEANUP_FAILED', 'Temporary R2 object requires cleanup', { cause: error });
        });
      }
    },
  };
}
