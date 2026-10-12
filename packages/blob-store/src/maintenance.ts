import type { R2Bucket } from '@cloudflare/workers-types';
import { BlobError } from './index.js';
import { validateKey } from './verify.js';

/** Destructive operator capability. The caller must prove irreversible retirement
 * in the owning database before invoking it; this is never a public HTTP route. */
export interface BlobRemover { removeRetired(key: string): Promise<void> }
export function validateRetiredKey(key: string) {
  validateKey(key);
  if (!key.startsWith('assets/')) throw new BlobError('INVALID_KEY', 'Cleanup only accepts Unity asset storage keys');
}
export function createR2BlobRemover(bucket: Pick<R2Bucket, 'delete'>): BlobRemover {
  return { async removeRetired(key) { validateRetiredKey(key); await bucket.delete(key); } };
}
