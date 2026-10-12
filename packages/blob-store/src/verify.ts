import { sha256 } from '@noble/hashes/sha2.js';
import { BlobError } from './index.js';
import type { BlobIntegrity } from './index.js';

export function validateKey(key: string): void {
  const [namespace, name, extra] = key.split('/');
  if (!['assets', 'originals'].includes(namespace ?? '') || !name || name.length > 128
    || /[^a-z0-9-]/.test(name) || extra !== undefined) throw new BlobError('INVALID_KEY', 'Invalid immutable object key');
}
export function validateIntegrity(expected: BlobIntegrity, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(expected.byteLength)
    || expected.byteLength < 0 || typeof expected.hash !== 'string' || expected.hash.length !== 64 || /[^a-f0-9]/.test(expected.hash)) {
    throw new BlobError('INVALID_INPUT', 'Expected a SHA-256 digest and non-negative byte length');
  }
  if (expected.byteLength > maxBytes) throw new BlobError('TOO_LARGE', 'Object exceeds the configured byte limit');
}
export async function cancelBody(body: ReadableStream<Uint8Array>, reason?: unknown): Promise<void> {
  if (!body.locked) await body.cancel(reason).catch(() => undefined);
}

/** Bridge runtime stream types through their byte-reader contract instead of unsafe type assertions. */
export function byteStream(reader: {
  read(): Promise<{ done: boolean; value?: unknown }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { controller.close(); reader.releaseLock(); }
        else if (result.value instanceof Uint8Array) controller.enqueue(result.value);
        else throw new BlobError('INTEGRITY', 'Storage returned a non-byte stream');
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  });
}

/** Bounded streaming verification. The sink receives backpressure-aware writes, never a whole-file buffer. */
export async function consumeVerified(body: ReadableStream<Uint8Array>, expected: BlobIntegrity,
  write: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<BlobIntegrity> {
  const reader = body.getReader();
  const digest = sha256.create();
  let byteLength = 0;
  let complete = false;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new BlobError('ABORTED', 'Upload aborted');
    while (true) {
      const result = await reader.read();
      if (signal?.aborted) throw new BlobError('ABORTED', 'Upload aborted');
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new BlobError('INVALID_INPUT', 'Expected a byte stream');
      byteLength += result.value.byteLength;
      if (byteLength > expected.byteLength) throw new BlobError('TOO_LARGE', 'Stream exceeds its declared byte length');
      // A producer can reuse its buffer while an asynchronous sink is writing.
      // Hash and persist the same owned snapshot, never a caller-owned view.
      const chunk = new Uint8Array(result.value);
      digest.update(chunk);
      await write(chunk);
    }
    const hash = Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (byteLength !== expected.byteLength || hash !== expected.hash) throw new BlobError('INTEGRITY', 'Stream does not match its declared digest and length');
    complete = true;
    return { hash, byteLength };
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    digest.destroy();
  }
}
