export interface BlobIntegrity { hash: string; byteLength: number }
export interface StoredBlob { body: ReadableStream<Uint8Array>; byteLength: number }
export interface BlobStore {
  /** Publish verified bytes atomically. Existing keys may be retried but never overwritten. */
  put(key: string, body: ReadableStream<Uint8Array>, expected: BlobIntegrity, options?: { signal?: AbortSignal }): Promise<BlobIntegrity>;
  /** Read existing bytes only; no fetch, repair or cache population. Caller owns/cancels the stream. */
  get(key: string): Promise<StoredBlob | null>;
}
export type BlobErrorCode = 'INVALID_KEY' | 'INVALID_INPUT' | 'TOO_LARGE' | 'INTEGRITY' | 'ABORTED' | 'CLEANUP_FAILED';
export class BlobError extends Error {
  constructor(public readonly code: BlobErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BlobError';
  }
}
export const defaultMaxBytes = 32 * 1024 * 1024;
